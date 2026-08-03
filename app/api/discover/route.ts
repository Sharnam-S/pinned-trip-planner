import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { curateVideos, gatherCandidates, planSearchQueries } from "@/lib/discover";
import { parseTripTag, withLlmUser } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { TripQuery } from "@/lib/types";
import { geocodeBounds } from "@/lib/geocode";

export const runtime = "nodejs";
// Sonnet planning + YouTube searches + Sonnet curation in one call
export const maxDuration = 300;

const PICK_COUNT = 20;

/**
 * Search-mode step 1: turn a destination/dates/interests query into a ranked
 * set of videos. Stateless — the browser saves the result into the visitor's
 * localStorage trip and drives per-video processing from there.
 */
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server." },
      { status: 500 }
    );
  }
  // Charge the account, not the IP — see lib/ratelimit.ts. The session probe
  // moves above the limiter so signed-in callers get their own allowance.
  const user = await getSessionUser();
  if (!rateLimit(req, "discover", 20, user?.id)) return rateLimited();

  const body = await req.json();
  if (typeof body.destination !== "string" || !body.destination.trim()) {
    return NextResponse.json({ error: "Tell us where you're going." }, { status: 400 });
  }
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

  // One PostHog trace groups both LLM calls of this discover request;
  // withLlmUser attributes every capture inside to the signed-in account.
  const traceId = randomUUID();
  const trip = parseTripTag(body);
  return withLlmUser(user, async () => {
    const plan = await planSearchQueries(query, traceId, trip);
  const candidates = await gatherCandidates(plan.queries);
  if (candidates.length === 0) {
    return NextResponse.json(
      {
        error: `Couldn't find travel videos for "${plan.resolvedDestination}". Try a different destination spelling.`,
      },
      { status: 404 }
    );
  }

  const ranked = await curateVideos(candidates, query, plan, traceId, trip);
  if (ranked.length === 0) {
    return NextResponse.json(
      {
        error: `None of the videos found looked like real travel guides for "${plan.resolvedDestination}".`,
      },
      { status: 404 }
    );
  }

  // The destination's real extent, resolved once so the trip knows what "here"
  // means. Best-effort: a geocoder miss must not fail a build, it just means
  // no spot gets quarantined (see applyVideoResult).
  const geo = await geocodeBounds(plan.resolvedDestination);

  const byId = new Map(candidates.map((c) => [c.id, c]));
  return NextResponse.json({
    resolvedDestination: plan.resolvedDestination,
    bounds: geo?.bounds ?? null,
    subAreas: plan.subAreas,
    videos: ranked.slice(0, PICK_COUNT).map((id) => ({
      id,
      title: byId.get(id)?.title ?? "",
      channelName: byId.get(id)?.channelName ?? "",
    })),
      bench: ranked.slice(PICK_COUNT),
    });
  });
}
