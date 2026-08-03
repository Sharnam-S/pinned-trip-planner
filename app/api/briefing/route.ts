import { NextRequest, NextResponse } from "next/server";
import { parseTripTag, withLlmUser } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { synthesizeBriefing } from "@/lib/briefingSynth";
import { BRIEFING_TOPIC_IDS, MAX_TRIP_NOTES, trimQuote } from "@/lib/briefing";
import { BriefingNote, BriefingTopic } from "@/lib/types";

export const runtime = "nodejs";
// One small call — nothing like the transcript routes.
export const maxDuration = 120;

const TOPICS = new Set<string>(BRIEFING_TOPIC_IDS);

/** The notes come from the browser (trips live client-side), so nothing here is
 *  trusted: shape, topic, length and count are all re-checked before they reach
 *  a prompt. */
function parseNotes(raw: unknown): BriefingNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: BriefingNote[] = [];
  for (const item of raw.slice(0, MAX_TRIP_NOTES)) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    if (typeof n.topic !== "string" || !TOPICS.has(n.topic)) continue;
    if (typeof n.point !== "string" || !n.point.trim()) continue;
    if (typeof n.videoId !== "string" || !/^[\w-]{11}$/.test(n.videoId)) continue;
    notes.push({
      topic: n.topic as BriefingTopic,
      point: n.point.trim().slice(0, 400),
      quote: typeof n.quote === "string" ? trimQuote(n.quote) : "",
      videoId: n.videoId,
      timestampSec:
        typeof n.timestampSec === "number" && Number.isFinite(n.timestampSec)
          ? Math.max(0, Math.floor(n.timestampSec))
          : 0,
    });
  }
  return notes;
}

/**
 * Writes the destination briefing for one trip. Stateless, like every other
 * route here: the browser owns the trip, sends the notes, and stores what comes
 * back.
 */
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server." },
      { status: 500 }
    );
  }
  const user = await getSessionUser();
  if (!rateLimit(req, "briefing", 40, user?.id)) return rateLimited();

  const body = await req.json().catch(() => ({}));
  const destination =
    typeof body.destination === "string" && body.destination.trim()
      ? body.destination.trim().slice(0, 200)
      : "";
  if (!destination) {
    return NextResponse.json({ error: "destination is required." }, { status: 400 });
  }
  const notes = parseNotes(body.notes);

  try {
    const briefing = await withLlmUser(user, () =>
      synthesizeBriefing(notes, destination, parseTripTag(body))
    );
    // null is a legitimate outcome (nothing worth saying), not an error — the
    // caller stores it and stops asking.
    return NextResponse.json({ briefing });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
