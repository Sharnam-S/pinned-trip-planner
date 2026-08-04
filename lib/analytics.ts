/**
 * Product events, as opposed to LLM events.
 *
 * Everything the planner reported until now was `$ai_generation` — one row per
 * model call. That makes cost and latency legible and everything else invisible:
 * a review of nine real trips turned up builds dying as "All videos failed",
 * conversations ending with no itinerary, and a tool error that destroyed a
 * chat, none of which leave a trace in LLM analytics. These events are the
 * missing half.
 *
 * Server-side on purpose: the PostHog key stays out of the browser, and the
 * distinct id comes from the session cookie rather than anything a client could
 * claim. The client calls `track()` in lib/track.ts, which posts here.
 */
import { PostHog } from "posthog-node";
import type { SessionUser } from "./auth";

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      // `||`, not `??` — an unset key in a .env file is "", not undefined.
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

/**
 * The events we accept, and nothing else. An allowlist rather than a pass-through
 * because this route is public: without it, anyone could mint arbitrary event
 * names into the project and make the funnels useless.
 */
export const PRODUCT_EVENTS = [
  // Build pipeline (lib/runner.ts)
  "build_started",
  "build_completed",
  "build_failed",
  "first_pin_visible",
  // Destination briefing (lib/runner.ts, components/TripBriefing.tsx).
  // The feature is a bet that travelers want the non-place half of the videos;
  // `briefing_opened` over `briefing_written` is the only thing that settles
  // whether a collapsed section above the pins earns its place.
  "briefing_written",
  "briefing_opened",
  // Notes recovered from the video cache for a trip built before briefings
  // existed. Worth its own event: it's the only signal that the recovery path
  // is reaching real trips rather than quietly finding nothing.
  "briefing_backfilled",
  // Planner (components/PlannerChat.tsx)
  "itinerary_committed",
  "planner_tool_error",
  "question_card_shown",
  "question_card_answered",
  // The agent handing the turn back to itself when the build lands, after it
  // told the traveler it would wait. Paired with itinerary_committed it answers
  // the only question that matters here: does the pickup actually end in a
  // plan, or does it just add a message nobody asked for?
  "planner_picked_up",
] as const;

export type ProductEvent = (typeof PRODUCT_EVENTS)[number];

export function isProductEvent(name: unknown): name is ProductEvent {
  return (
    typeof name === "string" &&
    (PRODUCT_EVENTS as readonly string[]).includes(name)
  );
}

/** Property values are scalars only — a nested object here would be a nested
 *  object in every PostHog breakdown, which is unqueryable. */
export type EventProps = Record<string, string | number | boolean | null>;

const MAX_PROPS = 25;
const MAX_STRING = 500;

/** Trim to something a public endpoint can safely forward. */
export function sanitizeProps(raw: unknown): EventProps {
  if (!raw || typeof raw !== "object") return {};
  const out: EventProps = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROPS) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_STRING);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

/**
 * Capture one product event. Keyed to the signed-in account so it lines up with
 * `$ai_generation` (which does the same), and anonymous otherwise — with person
 * profiles off, so a stream of one-off visitors can't inflate the person count.
 */
export async function captureProductEvent(
  event: ProductEvent,
  props: EventProps,
  user: SessionUser | null
): Promise<void> {
  if (!posthog) return;
  posthog.capture({
    distinctId: user?.id ?? `anon:${props.tripId ?? "unknown"}`,
    event,
    properties: {
      ...props,
      ...(user
        ? { userId: user.id, $set: { email: user.email, name: user.name } }
        : { $process_person_profile: false }),
    },
  });
  await posthog.flush().catch(() => {});
}
