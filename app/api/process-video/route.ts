import { NextRequest, NextResponse } from "next/server";
import { parseTripTag, withLlmUser } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth";
import { processVideo } from "@/lib/pipeline";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { TranscriptError } from "@/lib/youtube";
import { ExtractionError } from "@/lib/extract";

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
    const raw = err instanceof Error ? err.message : String(err);
    // The status is what tells the runner whether this video is bad or the
    // connection is: 429/503 means retry THIS video shortly, 422 means it's a
    // dud and the bench should supply a replacement. Getting that wrong is how
    // a throttled build used to burn its whole bench and die (see
    // TranscriptError in lib/youtube.ts).
    const kind = err instanceof TranscriptError ? err.kind : null;
    const status =
      kind === "rate-limited" ? 429 : kind === "network" ? 503 : 422;

    // Whatever goes in `error` is rendered next to the video's title on the
    // build screen, so it has to be a sentence. TranscriptError already writes
    // those; ExtractionError writes short ones too. ANYTHING ELSE is an
    // exception message, and one of those — a zod validation dump listing all
    // fourteen category values — was shown to a traveler in full, wrapped
    // across fifteen lines and overflowing the card. The detail belongs in the
    // logs, which is where it now goes.
    console.warn(`[process-video] ${videoId} failed:`, raw);
    const message =
      kind || err instanceof ExtractionError
        ? raw
        : "We couldn't read this video.";
    return NextResponse.json(
      { error: message, kind: kind ?? "unknown" },
      {
        status,
        headers: status === 429 ? { "Retry-After": "20" } : undefined,
      }
    );
  }
}
