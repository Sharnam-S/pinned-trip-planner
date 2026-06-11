import { NextRequest, NextResponse } from "next/server";
import { deleteTrip, getTrip } from "@/lib/store";
import { backfillPhotos } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  // older trips predate spot photos — resolve them in the background while
  // the client polls; each found photo is saved immediately
  if (trip.status === "ready" && trip.spots.some((s) => s.photo === undefined)) {
    backfillPhotos(id).catch(() => {});
  }
  return NextResponse.json(trip);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  deleteTrip(id);
  return NextResponse.json({ ok: true });
}
