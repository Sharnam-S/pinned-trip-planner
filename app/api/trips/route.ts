import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { listTrips, saveTrip } from "@/lib/store";
import { makeTrip, processTrip } from "@/lib/pipeline";
import { parseVideoId } from "@/lib/youtube";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(listTrips());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const urls: string[] = Array.isArray(body.urls) ? body.urls : [];

  const parsed = urls
    .map((u) => ({ url: u.trim(), id: parseVideoId(u) }))
    .filter((u) => u.url.length > 0);

  const invalid = parsed.filter((p) => !p.id).map((p) => p.url);
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Not valid YouTube links: ${invalid.join(", ")}` },
      { status: 400 }
    );
  }

  const unique = [...new Map(parsed.map((p) => [p.id as string, p])).values()];
  if (unique.length === 0) {
    return NextResponse.json({ error: "Paste at least one YouTube link." }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  const tripId = crypto.randomBytes(6).toString("hex");
  const trip = makeTrip(
    tripId,
    unique.map((u) => ({ id: u.id as string, url: u.url }))
  );
  saveTrip(trip);

  // Fire-and-forget: the client polls GET /api/trips/[id] for progress.
  void processTrip(tripId);

  return NextResponse.json({ id: tripId });
}
