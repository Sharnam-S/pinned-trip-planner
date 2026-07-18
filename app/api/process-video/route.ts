import { NextRequest, NextResponse } from "next/server";
import { parseTripTag } from "@/lib/llm";
import { processVideo } from "@/lib/pipeline";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";
// transcript fetch + Claude extraction + per-spot geocoding
export const maxDuration = 300;

/**
 * Search-mode step 2 (and the add-your-own-links path): read one video and
 * return resolved spots. Stateless — the browser merges the result into the
 * visitor's localStorage trip.
 */
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server." },
      { status: 500 }
    );
  }
  if (!rateLimit(req, "process-video", 80)) return rateLimited();

  const body = await req.json();
  const videoId: string = typeof body.videoId === "string" ? body.videoId : "";
  if (!/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video id." }, { status: 400 });
  }
  const knownSpotNames: string[] = Array.isArray(body.knownSpotNames)
    ? body.knownSpotNames.filter((n: unknown) => typeof n === "string").slice(0, 300)
    : [];

  try {
    const result = await processVideo(videoId, knownSpotNames, parseTripTag(body));
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "No transcript available" → the client substitutes from the bench
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
