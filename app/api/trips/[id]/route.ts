import { NextRequest, NextResponse } from "next/server";
import { getTrip, isReadOnly } from "@/lib/store";
import { deleteTripFromBlob, getBlobTrip } from "@/lib/blobStore";
import { backfillPhotos, needsGoogleUpgrade, upgradeTripWithGoogle } from "@/lib/pipeline";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Serves a trip by id: repo sample first, then the shared Blob library.
 *  Visitor-created trips render from localStorage and never reach this. */
export async function GET(
  _req: NextRequest,
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
    return NextResponse.json({ ...sample, upgrading });
  }

  const shared = await getBlobTrip(id).catch(() => null);
  if (shared) return NextResponse.json(shared);

  return NextResponse.json({ error: "Trip not found" }, { status: 404 });
}

/** Remove a trip from the shared library. The client only offers this for
 *  trips this browser created/uploaded (its "owned" set), so it doubles as
 *  the un-publish action. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!rateLimit(req, "unpublish", 60)) return rateLimited();
  const { id } = await params;
  try {
    await deleteTripFromBlob(id);
  } catch {
    // already gone / blob disabled — deleting is idempotent from the UI's view
  }
  return NextResponse.json({ ok: true });
}
