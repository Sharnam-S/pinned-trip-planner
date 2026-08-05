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
  // --- Interactions -------------------------------------------------------
  // Autocapture (components/Analytics.tsx) covers clicks broadly, by DOM
  // label. These are the handful where the ANSWER matters enough to want a
  // stable name and real properties rather than "button with text 'Filters'":
  // each one settles a question the product has been guessing at.
  //
  // Does the map get browsed by category, and which? (Feeds the filter chips
  // and, indirectly, what extraction should be good at.)
  "filter_applied",
  // Do people open pins at all, or only read the plan?
  "spot_opened",
  // The must-see picker is the first personalisation question we ask, and it
  // was measurably asking the wrong three things (§4.9).
  "must_see_starred",
  // #97 built parallel plan options on the theory that people want to compare
  // shapes. Nothing has ever confirmed anyone switches between them.
  "plan_option_switched",
  // The two recovery paths, both of which cost real work to build and neither
  // of which has ever been observed being used: "+ <area>" on the coverage
  // note (§4.9) and "Show them anyway" on the out-of-range note (D3).
  "coverage_gap_clicked",
  "out_of_range_revealed",
  // The top of the funnel. Everything above is meaningless without it.
  "build_requested",
  "sample_opened",
  "trip_shared",
  // One place, several pins — reported as "The Quiraing", "Quiraing" and
  // "Quiraing Mountains (Trotternish Ridge)" all on one mountain. Emitted at
  // the end of a build for whatever the matching rules did NOT catch, because
  // this failure is invisible from inside any single video: extractions are
  // cached trip-independently, so no one of them can know what the others
  // called the same place.
  "duplicate_spots_detected",
  // NB: `feedback_submitted` is deliberately NOT here. It's captured directly
  // by `/api/feedback` through `captureFeedback` below, because it carries the
  // full message body and `sanitizeProps` would cut that to 500 characters.
  // Allowlisting it too would emit the same event twice per submission and
  // double every count.
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
  user: SessionUser | null,
  /** The browser SDK's distinct id, when the client sent one. Only used for
   *  ANONYMOUS visitors: it's what makes their pageviews (captured by
   *  posthog-js) and their product events land on the same person instead of
   *  two. A signed-in visitor is keyed to the account on both paths already. */
  clientDistinctId?: string | null
): Promise<void> {
  if (!posthog) return;
  posthog.capture({
    distinctId:
      user?.id ?? clientDistinctId ?? `anon:${props.tripId ?? "unknown"}`,
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

/**
 * One feedback / prompt submission, captured with its FULL text.
 *
 * Deliberately not a `PRODUCT_EVENTS` entry going through `sanitizeProps`:
 * that caps strings at 500 characters, and the whole point of the prompt box
 * is a long message someone dictated. Truncating it to a property-sized
 * snippet would leave the interesting half on the floor.
 *
 * This is the SECOND sink. Postgres is the durable record (`insertFeedback`);
 * this one exists so a deploy without DATABASE_URL still can't swallow
 * somebody's paragraph, and so the team sees it where they already look.
 */
export async function captureFeedback(
  kind: "feedback" | "prompt",
  message: string,
  meta: {
    contact?: string | null;
    tripId?: string | null;
    tripName?: string | null;
    stored: boolean;
  },
  user: SessionUser | null,
  clientDistinctId?: string | null
): Promise<void> {
  if (!posthog) return;
  posthog.capture({
    distinctId: user?.id ?? clientDistinctId ?? `anon:feedback`,
    event: "feedback_submitted",
    properties: {
      kind,
      message,
      chars: message.length,
      contact: meta.contact ?? null,
      tripId: meta.tripId ?? null,
      tripName: meta.tripName ?? null,
      // False means this row exists ONLY here — worth knowing before someone
      // reads the Postgres table and concludes that's all of it.
      stored: meta.stored,
      ...(user
        ? { userId: user.id, $set: { email: user.email, name: user.name } }
        : { $process_person_profile: false }),
    },
  });
  await posthog.flush().catch(() => {});
}
