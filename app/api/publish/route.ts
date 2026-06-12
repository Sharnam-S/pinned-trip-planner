import { NextRequest, NextResponse } from "next/server";
import { blobEnabled, publishTripToBlob } from "@/lib/blobStore";
import { asValidTrip } from "@/lib/validateTrip";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Writes a finished trip into the shared library. Called by the localhost
 * runner when a trip you built reaches "ready", and by /uploadtrip. One
 * shared pool — published trips show up in everyone's gallery.
 */
export async function POST(req: NextRequest) {
  if (!blobEnabled()) {
    return NextResponse.json(
      { error: "Sharing isn't configured on this server (no Blob store)." },
      { status: 503 }
    );
  }
  if (!rateLimit(req, "publish", 60)) return rateLimited();

  const body = await req.json().catch(() => null);
  const trip = asValidTrip(body);
  if (!trip) {
    return NextResponse.json({ error: "That doesn't look like a trip." }, { status: 400 });
  }

  // Strip transient flags before they're frozen into the shared copy
  delete (trip as { upgrading?: boolean }).upgrading;

  try {
    await publishTripToBlob(trip);
    return NextResponse.json({ ok: true, id: trip.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to publish." },
      { status: 500 }
    );
  }
}
