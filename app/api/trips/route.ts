import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { isReadOnly, listTrips, saveTrip } from "@/lib/store";
import { discoverAndProcess, makeSearchTrip, makeTrip, processTrip } from "@/lib/pipeline";
import { parseVideoId } from "@/lib/youtube";
import { TripQuery } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(listTrips());
}

export async function POST(req: NextRequest) {
  if (isReadOnly) {
    return NextResponse.json(
      { error: "This deployed copy is a read-only showcase — run Pinned locally to build new trips." },
      { status: 503 }
    );
  }
  const body = await req.json();

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  // Search mode: we find the videos on the user's behalf
  if (typeof body.destination === "string" && body.destination.trim().length > 0) {
    const query: TripQuery = {
      destination: body.destination.trim(),
      startDate: typeof body.startDate === "string" && body.startDate ? body.startDate : undefined,
      endDate: typeof body.endDate === "string" && body.endDate ? body.endDate : undefined,
      interests:
        typeof body.interests === "string" && body.interests.trim()
          ? body.interests.trim()
          : undefined,
    };
    if (query.startDate && query.endDate && query.endDate < query.startDate) {
      return NextResponse.json(
        { error: "The end date is before the start date." },
        { status: 400 }
      );
    }
    const tripId = crypto.randomBytes(6).toString("hex");
    saveTrip(makeSearchTrip(tripId, query));
    void discoverAndProcess(tripId);
    return NextResponse.json({ id: tripId });
  }

  // Link mode: explicit video URLs (used by the Sources "add videos" flow)
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
    return NextResponse.json({ error: "Tell us where you're going." }, { status: 400 });
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
