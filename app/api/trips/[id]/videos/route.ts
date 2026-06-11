import { NextRequest, NextResponse } from "next/server";
import { getTrip, saveTrip } from "@/lib/store";
import { processTrip } from "@/lib/pipeline";
import { parseVideoId } from "@/lib/youtube";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  if (trip.status === "processing") {
    return NextResponse.json(
      { error: "Trip is still processing — add more videos when it finishes." },
      { status: 409 }
    );
  }

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

  const fresh = parsed.filter(
    (p) => p.id && !trip.videos.some((v) => v.id === p.id)
  );
  if (fresh.length === 0) {
    return NextResponse.json({ error: "Those videos are already in this trip." }, { status: 400 });
  }

  for (const f of fresh) {
    trip.videos.push({
      id: f.id as string,
      url: f.url,
      title: "",
      channelName: "",
      channelAvatar: "",
      thumbnail: "",
      status: "pending",
    });
  }
  trip.status = "processing";
  trip.progress = "Processing new videos…";
  saveTrip(trip);

  void processTrip(id);

  return NextResponse.json({ ok: true });
}
