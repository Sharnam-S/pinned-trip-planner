import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { drivingMinutes, routesEnabled, type RoutePair } from "@/lib/routes";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Cap per request so one tool call can't fan out into a bill. A day has a
 *  handful of legs; 20 covers the longest sensible ask. */
const MAX_PAIRS = 20;

/**
 * Real driving times for the planner's `get_travel_times` tool. The tool
 * executes in the browser (the trip data lives there), so it calls here for the
 * one thing the browser can't know: how long the road actually takes.
 *
 * Answers 200 with nulls when routing is unavailable, so the client falls back
 * to its own estimate instead of the agent losing the tool entirely.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!rateLimit(req, "routes", 400, user?.id)) return rateLimited();

  const body = await req.json().catch(() => null);
  const raw = Array.isArray(body?.pairs) ? body.pairs : [];
  const pairs: RoutePair[] = raw
    .slice(0, MAX_PAIRS)
    .filter(
      (p: unknown): p is RoutePair =>
        typeof p === "object" &&
        p !== null &&
        Number.isFinite((p as RoutePair).from?.lat) &&
        Number.isFinite((p as RoutePair).from?.lng) &&
        Number.isFinite((p as RoutePair).to?.lat) &&
        Number.isFinite((p as RoutePair).to?.lng)
    );

  if (!routesEnabled() || pairs.length === 0) {
    return NextResponse.json({ enabled: false, minutes: pairs.map(() => null) });
  }
  return NextResponse.json({
    enabled: true,
    minutes: await drivingMinutes(pairs),
  });
}
