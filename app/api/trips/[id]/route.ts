import { NextRequest, NextResponse } from "next/server";
import { deleteTrip, getTrip, isReadOnly } from "@/lib/store";
import { backfillPhotos, needsGoogleUpgrade, upgradeTripWithGoogle } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  let upgrading = false;
  if (trip.status === "ready" && !isReadOnly) {
    // trips from before the Google key existed — re-resolve coords + photos
    // in the background while the client polls
    if (needsGoogleUpgrade(trip)) {
      upgrading = true;
      upgradeTripWithGoogle(id).catch(() => {});
    } else if (trip.spots.some((s) => s.photo === undefined)) {
      // older trips predate spot photos — fill from free sources. Never runs
      // concurrently with the Google upgrade (both load+save the same file);
      // the client keeps polling, so this picks up on the next GET.
      backfillPhotos(id).catch(() => {});
    }
  }
  return NextResponse.json({ ...trip, upgrading });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (isReadOnly) {
    return NextResponse.json(
      { error: "This deployed copy is a read-only showcase." },
      { status: 503 }
    );
  }
  const { id } = await params;
  deleteTrip(id);
  return NextResponse.json({ ok: true });
}
