import { NextRequest, NextResponse } from "next/server";
import { getTrip, isReadOnly } from "@/lib/store";
import { deleteTripFromBlob, getBlobTrip } from "@/lib/blobStore";
import { backfillPhotos, needsGoogleUpgrade, upgradeTripWithGoogle } from "@/lib/pipeline";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { authEnabled, getSessionUser } from "@/lib/auth";
import { dbEnabled, deleteDbTrip, getDbTrip, upsertDbTrip } from "@/lib/db";
import { asValidTrip } from "@/lib/validateTrip";

export const runtime = "nodejs";

// A trip JSON is typically tens-to-hundreds of KB; anything past this is not
// a trip this app produced.
const MAX_TRIP_BYTES = 4 * 1024 * 1024;

/** A trip is tens-to-hundreds of KB and reopening one is common, so every
 *  response carries an ETag and a revalidating cache directive: an unchanged
 *  trip costs a header exchange instead of the whole document. `private`
 *  because the same URL serves a different body per caller (your own copy vs
 *  the public one). */
function tripResponse(req: NextRequest, payload: unknown) {
  const body = JSON.stringify(payload);
  // djb2 over the body — same cheap hash the client uses for change detection.
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  const etag = `"${(h >>> 0).toString(36)}-${body.length.toString(36)}"`;
  const headers = {
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "Content-Type": "application/json",
  };
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(body, { status: 200, headers });
}

/** Serves a trip by id: repo sample first, then the caller's own saved trip,
 *  then the shared Blob library. Trips still being built render from the
 *  client's working copy and never reach this. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sample = getTrip(id);
  if (sample) {
    let upgrading = false;
    if (sample.status === "ready" && !isReadOnly) {
      // local dev: samples from before the Google key existed — re-resolve
      // coords + photos in the background while the client polls
      if (needsGoogleUpgrade(sample)) {
        upgrading = true;
        upgradeTripWithGoogle(id).catch(() => {});
      } else if (sample.spots.some((s) => s.photo === undefined)) {
        backfillPhotos(id).catch(() => {});
      }
    }
    return tripResponse(req, { ...sample, upgrading });
  }

  // The caller's own saved copy (fresher than any published one) — private:
  // someone else's trip URL keeps falling through to the public library.
  if (dbEnabled()) {
    const user = await getSessionUser();
    if (user) {
      const owned = await getDbTrip(id).catch(() => null);
      if (owned && owned.ownerId === user.id) {
        return tripResponse(req, { ...owned.trip, ownerId: user.id });
      }
    }
  }

  const shared = await getBlobTrip(id).catch(() => null);
  if (shared) return tripResponse(req, shared);

  return NextResponse.json({ error: "Trip not found" }, { status: 404 });
}

/** Saves the signed-in user's trip (create or update). The client pushes its
 *  localStorage copy here — debounced — so trips survive the browser and
 *  follow the account across devices. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!rateLimit(req, "trip-save", 120)) return rateLimited();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const raw = await req.text();
  if (raw.length > MAX_TRIP_BYTES) {
    return NextResponse.json({ error: "Trip is too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const { id } = await params;
  const trip = asValidTrip(body);
  if (!trip || trip.id !== id) {
    return NextResponse.json({ error: "That doesn't look like a trip." }, { status: 400 });
  }

  delete trip.upgrading; // transient API flag, never stored
  trip.ownerId = user.id;
  try {
    const ok = await upsertDbTrip(id, user.id, trip);
    if (!ok) {
      return NextResponse.json(
        { error: "This trip belongs to another account." },
        { status: 403 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save the trip." },
      { status: 500 }
    );
  }
}

/** Deletes a trip: the caller's saved copy (if signed in and theirs) plus the
 *  published community copy. A trip saved to someone else's account can't be
 *  removed by other callers. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!rateLimit(req, "unpublish", 60)) return rateLimited();
  const { id } = await params;

  if (dbEnabled() && authEnabled()) {
    const user = await getSessionUser();
    const saved = await getDbTrip(id).catch(() => null);
    if (saved && saved.ownerId !== user?.id) {
      return NextResponse.json(
        { error: "This trip belongs to another account." },
        { status: 403 }
      );
    }
    if (saved && user) await deleteDbTrip(id, user.id).catch(() => {});
  }

  try {
    await deleteTripFromBlob(id);
  } catch {
    // already gone / blob disabled — deleting is idempotent from the UI's view
  }
  return NextResponse.json({ ok: true });
}
