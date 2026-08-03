import { NextRequest, NextResponse } from "next/server";
import { parseTripTag, withLlmUser } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth";
import { processVideo } from "@/lib/pipeline";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { TranscriptError } from "@/lib/youtube";

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
  const user = await getSessionUser();
  if (!rateLimit(req, "process-video", 200, user?.id)) return rateLimited();

  const body = await req.json();
  const videoId: string = typeof body.videoId === "string" ? body.videoId : "";
  if (!/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video id." }, { status: 400 });
  }
  const knownSpotNames: string[] = Array.isArray(body.knownSpotNames)
    ? body.knownSpotNames.filter((n: unknown) => typeof n === "string").slice(0, 300)
    : [];

  try {
    const result = await withLlmUser(user, () =>
      processVideo(videoId, knownSpotNames, parseTripTag(body))
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The status is what tells the runner whether this video is bad or the
    // connection is: 429/503 means retry THIS video shortly, 422 means it's a
    // dud and the bench should supply a replacement. Getting that wrong is how
    // a throttled build used to burn its whole bench and die (see
    // TranscriptError in lib/youtube.ts).
    const kind = err instanceof TranscriptError ? err.kind : null;
    const status =
      kind === "rate-limited" ? 429 : kind === "network" ? 503 : 422;
    return NextResponse.json(
      { error: message, kind: kind ?? "unknown" },
      {
        status,
        headers: status === 429 ? { "Retry-After": "20" } : undefined,
      }
    );
  }
}
