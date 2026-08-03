/**
 * The planner agent's itinerary: zod schemas shared by the chat route (tool
 * definitions) and the client (validation before saving), plus persistence
 * and geo helpers. The itinerary is a data object the agent edits via the
 * update_itinerary tool — never prose in the chat.
 */
import { z } from "zod";
import { Itinerary, ItinerarySlot, Spot, Trip } from "./types";
import { peekTrip, saveTrip } from "./tripStore";

/** The model reaches for time-of-day words beyond the canonical three
 *  ("midday", "night", "lunch"). Map the common synonyms onto the real slots
 *  and drop anything we can't place — the field is an optional grouping hint,
 *  so a value we don't recognize is better dropped than allowed to break the
 *  plan. */
const SLOT_ALIASES: Record<string, ItinerarySlot> = {
  morning: "morning",
  breakfast: "morning",
  "early morning": "morning",
  midday: "afternoon",
  noon: "afternoon",
  lunch: "afternoon",
  afternoon: "afternoon",
  evening: "evening",
  night: "evening",
  nighttime: "evening",
  dinner: "evening",
  sunset: "evening",
};

export function normalizeSlot(raw?: string): ItinerarySlot | undefined {
  if (!raw) return undefined;
  return SLOT_ALIASES[raw.trim().toLowerCase()];
}

// --- Tool input schemas (what the model sends) ---

/** One day of a plan. Extracted so the whole-plan path and the patch path share
 *  exactly the same content contract — the required fields inside are the ones
 *  §4.1 proved only hold when the SCHEMA demands them, and a patched day must be
 *  held to the identical bar as a written one. */
const DayInputSchema = z.object({
  label: z.string().describe('Short label, e.g. "Day 1"'),
  date: z
    .string()
    .optional()
    .describe("yyyy-mm-dd if travel dates are known"),
  theme: z
    .string()
    .describe(
      'The day\'s EXPERIENTIAL theme — what kind of day it is, not where. Good: "Harbor icons & a sunset bridge walk", "Slow morning, street-food afternoon". Bad: spot names joined with "+". Never list locations here; the map already shows them.'
    ),
  rationale: z
    .string()
    .describe(
      "1-2 sentences selling the day's logic: why these spots belong together, why this order, what the day feels like (geography, opening hours, energy curve). Shown to the user on the map — write for them, not for a log."
    ),
  stops: z
    .array(
      z.object({
        spotId: z
          .string()
          .describe("A spot id from the trip context, exactly as given"),
        // Kept lenient on purpose: this is an optional, low-stakes
        // grouping hint, and the model reaches for synonyms ("midday",
        // "night"). A strict enum would reject the ENTIRE plan over one
        // stray value, so accept any string and normalize downstream in
        // validateItinerary rather than hard-failing the tool call.
        slot: z
          .string()
          .optional()
          .describe(
            'Rough time-of-day bucket — one of "morning", "afternoon", "evening".'
          ),
        // Required: an itinerary without times doesn't answer "when do
        // I start and when am I done" — the whole point of the plan.
        time: z
          .string()
          .describe('Planned arrival, 24h "HH:MM", e.g. "09:30"'),
        durationMin: z
          .number()
          .describe("Minutes to spend at this stop (estimate honestly)"),
        why: z
          .string()
          .describe(
            "1-2 sentences answering all three: (1) why this spot is worth the user's time (what makes it special — lean on the creators' takes), (2) why THIS day, (3) why THIS time of day — for a time-sensitive spot (sunset light, calm morning water, midday shade/heat, tide/swell, pre-crowd) this MUST name that reason, not a generic \"afternoon works\". Shown on the spot's card. Not a practical tip — tips go in note."
          ),
        note: z
          .string()
          .optional()
          .describe("Practical tip for this stop, one sentence"),
      })
    )
    .describe("Stops in visit order"),
});

export const ItineraryInputSchema = z.object({
  // Required, not optional: a trip holds several options side by side, so
  // "which one am I writing" is never a safe default. §4.1 — the schema is
  // where a guarantee lives; the description is where the create-vs-replace
  // rule lives.
  planId: z
    .string()
    .describe(
      'Which option this plan is. To CHANGE an option that already exists, pass its exact id from the "PLAN OPTIONS" list in the context. To create a NEW option alongside the existing ones, invent a short kebab-case slug describing it ("east-coast", "with-national-park"). Never reuse another option\'s id for a different plan.'
    ),
  // A whole-option rewrite to move two stops is the single most expensive habit
  // this agent has: measured turns spent >5 minutes and three full rewrites of a
  // 40-stop plan on one edit, past the route's own 300s ceiling. "patch" makes
  // the cheap thing possible; the description makes it the obvious choice.
  mode: z
    .enum(["replace", "patch"])
    .optional()
    .describe(
      'How to write this option. "patch" = you are EDITING days of a plan that already exists: send only the days that change, in dayPatches. "replace" = you are creating a new option, or rewriting most of an existing one: send every day in days. Default if omitted: replace. Editing one or two days of an existing plan MUST use patch — rewriting ten days to change one wastes the traveler\'s time watching it stream.'
    ),
  title: z
    .string()
    .optional()
    .describe(
      'Short name for this option, max 4 words, naming what makes it DIFFERENT from the others — the tradeoff the traveler is choosing between. Good: "East coast only", "East, south & airport", "With Yala park". Bad: "Sri Lanka trip", "Option 2", "Best plan". REQUIRED when creating or replacing; omit when patching to keep the existing title.'
    ),
  days: z
    .array(DayInputSchema)
    .optional()
    .describe(
      "Every day of the option, in order. Required for mode=replace (and when creating a new option) — this replaces the option entirely."
    ),
  dayPatches: z
    .array(
      z.object({
        index: z
          .number()
          .describe(
            "0-based position of the day being changed — day 1 of the plan is index 0. Every other day is left exactly as it is."
          ),
        day: DayInputSchema,
      })
    )
    .optional()
    .describe(
      "Only for mode=patch: the days that change, each with its position. Send nothing else — untouched days keep their current stops, times, themes and rationale."
    ),
  stay: z
    .object({
      name: z.string(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      note: z.string().optional(),
    })
    .optional()
    .describe("Where the user is staying (or your recommended area)"),
  pace: z.enum(["packed", "balanced", "relaxed"]).optional(),
  budget: z.string().optional().describe('e.g. "mid-range, ~$100/day"'),
});

export type ItineraryInput = z.infer<typeof ItineraryInputSchema>;

export const TravelTimesInputSchema = z.object({
  pairs: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .max(20)
    .describe("Spot-id pairs to estimate travel between (max 20)"),
});

export type TravelTimesInput = z.infer<typeof TravelTimesInputSchema>;

export const AskQuestionsInputSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().describe("Short stable id, e.g. 'pace' or 'who'"),
        prompt: z.string().describe("The question, one short line"),
        options: z
          .array(z.string())
          .describe(
            "2-6 concrete choices shown as tappable chips. Empty array = free-text only."
          ),
        multiSelect: z
          .boolean()
          .optional()
          .describe("true if the user may pick more than one option"),
        allowOther: z
          .boolean()
          .optional()
          .describe("true to show a free-text 'something else' box"),
      })
    )
    .max(6)
    .describe(
      "3-5 quick questions the user taps through one at a time. Use to gather intake or a specific preference — never ask these in prose."
    ),
});

export type AskQuestionsInput = z.infer<typeof AskQuestionsInputSchema>;

export const FindSpotsInputSchema = z.object({
  area: z
    .string()
    .optional()
    .describe("A locality/neighbourhood to search within, e.g. 'Ahangama'"),
  interest: z
    .string()
    .optional()
    .describe("A theme or activity to find, e.g. 'spa, yoga' or 'street food'"),
});

export type FindSpotsInput = z.infer<typeof FindSpotsInputSchema>;

export const DiscardPlanInputSchema = z.object({
  planId: z
    .string()
    .describe(
      'The exact id of the option to delete, from the "PLAN OPTIONS" list in the context.'
    ),
});

export type DiscardPlanInput = z.infer<typeof DiscardPlanInputSchema>;

export const LoadPlanInputSchema = z.object({
  planId: z
    .string()
    .describe(
      'The exact id of the summarized option you need in full, from the "PLAN OPTIONS" list.'
    ),
});

export type LoadPlanInput = z.infer<typeof LoadPlanInputSchema>;

const MAX_DAYS = 14;
const MAX_STOPS_PER_DAY = 10;

/** How many parallel options a trip can hold. Four is the point where a
 *  switcher still reads as a set of choices rather than a list to manage —
 *  and where the volatile context block (every plan in full, every turn)
 *  stays affordable. */
export const MAX_PLANS = 4;

/** Normalize a model-sent itinerary against the trip's real spots: drop
 *  unknown ids and duplicates (first occurrence wins), cap sizes. Warnings go
 *  back to the model in the tool result so it can self-correct. */
type DayInput = z.infer<typeof DayInputSchema>;

/**
 * Turn a tool call into the full list of days it means, whether it arrived as a
 * whole plan or as patches onto one. Returns an `error` string instead of
 * throwing so the caller can hand it straight back as the tool result — the
 * model then fixes it in the same turn, which is how every other refusal in this
 * file behaves (see upsertPlan's MAX_PLANS message).
 */
function resolveDays(
  input: ItineraryInput,
  existing: Itinerary | undefined
): { days: DayInput[]; warnings: string[]; error?: string } {
  const patching = input.mode === "patch";
  if (!patching) {
    if (!input.days?.length) {
      return {
        days: [],
        warnings: [],
        error:
          'No days received. For mode="replace" (the default) send the complete plan in `days`; to change a few days of an existing option send mode="patch" with `dayPatches`.',
      };
    }
    return { days: input.days, warnings: [] };
  }

  if (!existing) {
    return {
      days: [],
      warnings: [],
      error: `Can't patch "${input.planId}" — no option with that id exists yet. Send the whole plan with mode="replace" to create it.`,
    };
  }
  if (!input.dayPatches?.length) {
    return {
      days: [],
      warnings: [],
      error:
        'mode="patch" needs `dayPatches` — a list of { index, day } for the days that change.',
    };
  }

  const warnings: string[] = [];
  // Start from what's stored, not from props: two tool calls can land in one
  // turn before React re-renders (§2d), so the base must be re-read state.
  const days: DayInput[] = existing.days.map((d) => ({
    label: d.label ?? "",
    date: d.date,
    theme: d.theme ?? "",
    rationale: d.rationale ?? "",
    stops: (d.stops ?? []).map((s) => ({
      spotId: s.spotId,
      slot: s.slot,
      time: s.time ?? "",
      durationMin: s.durationMin ?? 0,
      why: s.why ?? "",
      note: s.note,
    })),
  }));

  for (const patch of input.dayPatches) {
    if (patch.index < 0 || patch.index >= days.length) {
      // Appending is a legitimate intent ("add a day 8"), so allow the next
      // index up; anything beyond that is a mistake worth naming.
      if (patch.index === days.length) {
        days.push(patch.day);
        continue;
      }
      warnings.push(
        `Ignored a patch for day index ${patch.index} — "${input.planId}" has ${days.length} days (valid indexes 0-${days.length - 1}, or ${days.length} to append).`
      );
      continue;
    }
    days[patch.index] = patch.day;
  }
  return { days, warnings };
}

export function validateItinerary(
  input: ItineraryInput,
  spots: Spot[],
  existing?: Itinerary
): { itinerary: Itinerary; warnings: string[]; error?: string } {
  const known = new Set(spots.map((s) => s.id));
  const seen = new Set<string>();

  const resolved = resolveDays(input, existing);
  if (resolved.error) {
    return {
      itinerary: existing ?? {
        id: slugPlanId(input.planId),
        title: input.title?.trim() || "Untitled plan",
        days: [],
        updatedAt: new Date().toISOString(),
      },
      warnings: [],
      error: resolved.error,
    };
  }
  const warnings = [...resolved.warnings];

  if (resolved.days.length > MAX_DAYS) {
    warnings.push(`Plan capped at ${MAX_DAYS} days.`);
  }

  const days = resolved.days.slice(0, MAX_DAYS).map((day, i) => {
    const stops = [];
    for (const stop of day.stops) {
      if (!known.has(stop.spotId)) {
        warnings.push(
          `Dropped unknown spot id "${stop.spotId}" from ${day.label || `day ${i + 1}`} — use ids from the trip context exactly.`
        );
        continue;
      }
      if (seen.has(stop.spotId)) {
        warnings.push(
          `Dropped duplicate stop "${stop.spotId}" from ${day.label || `day ${i + 1}`} — each spot can appear once.`
        );
        continue;
      }
      if (stops.length >= MAX_STOPS_PER_DAY) {
        warnings.push(
          `${day.label || `Day ${i + 1}`} capped at ${MAX_STOPS_PER_DAY} stops.`
        );
        break;
      }
      seen.add(stop.spotId);
      stops.push({
        spotId: stop.spotId,
        slot: normalizeSlot(stop.slot),
        time: stop.time,
        durationMin: stop.durationMin,
        why: stop.why,
        note: stop.note,
      });
    }
    return {
      label: day.label || `Day ${i + 1}`,
      date: day.date,
      theme: day.theme,
      rationale: day.rationale,
      stops,
    };
  });

  return {
    itinerary: {
      id: slugPlanId(input.planId),
      // A patch keeps everything it didn't mention — title, stay, pace and
      // budget included. Re-sending them just to preserve them is exactly the
      // waste patch mode exists to remove.
      title: input.title?.trim() || existing?.title || "Untitled plan",
      days,
      stay: input.stay ?? existing?.stay,
      pace: input.pace ?? existing?.pace,
      budget: input.budget ?? existing?.budget,
      updatedAt: new Date().toISOString(),
    },
    warnings,
  };
}

/**
 * The whole write, atomically: re-read stored plans, resolve a patch or a
 * replace against the option as it actually is, validate, and save. One function
 * because the read and the write must not be separated — two update_itinerary
 * calls can land in a single turn before React re-renders, and a base taken from
 * props would make the second silently drop the first (§2d, §5.8).
 */
export function applyPlanUpdate(
  trip: Trip,
  isLocal: boolean,
  input: ItineraryInput,
  spots: Spot[]
): {
  plans: Itinerary[];
  itinerary: Itinerary;
  created: boolean;
  warnings: string[];
  /** Set when the call couldn't be applied at all — hand it back as the tool
   *  result so the model can correct itself in the same turn. */
  rejected?: string;
  /** How the write was expressed, for telemetry and for the nudge below. */
  mode: "replace" | "patch";
} {
  const live = isLocal ? (peekTrip(trip.id) ?? trip) : trip;
  const stored = loadPlans(live, isLocal);
  const id = slugPlanId(input.planId);
  const existing = stored.find((p) => p.id === id);
  const mode = input.mode === "patch" ? "patch" : "replace";

  const { itinerary, warnings, error } = validateItinerary(input, spots, existing);
  if (error) {
    return {
      plans: stored,
      itinerary,
      created: false,
      warnings,
      rejected: error,
      mode,
    };
  }

  const { plans, created, rejected } = upsertPlan(trip, isLocal, itinerary);
  if (rejected) {
    return { plans, itinerary, created: false, warnings, rejected, mode };
  }

  // Feedback beats prohibition: a full rewrite that changed almost nothing is
  // the expensive habit, so name it in the tool result where the model will
  // actually read it, rather than adding another rule it can quietly skip.
  if (mode === "replace" && existing && existing.days.length >= 4) {
    const changed = countChangedDays(existing, itinerary);
    if (changed > 0 && changed <= 2) {
      warnings.push(
        `You rewrote all ${itinerary.days.length} days to change ${changed}. Next time use mode="patch" with dayPatches — it's faster for the traveler and leaves the other days untouched.`
      );
    }
  }

  // A "new option" that's really the old one again is worse than no option: it
  // costs a full plan write, it fills a slot out of MAX_PLANS, and it hands the
  // traveler a comparison with nothing to compare. Observed: a second Sri Lanka
  // option shared 31 of 35 stops with the first, because the alternative they
  // asked for ("skip the hill country") was already true of the plan they had.
  const twin = nearestTwin(itinerary, plans);
  if (twin) {
    warnings.push(
      `This is ${Math.round(twin.overlap * 100)}% the same trip as "${twin.plan.title}" (${twin.shared} of ${twin.total} stops identical). Options are only useful if they're genuinely different shapes — either differentiate this one, or tell the traveler their existing plan already covers what they asked for and discard it.`
    );
  }

  return { plans, itinerary, created, warnings, mode };
}

/** The most similar OTHER option, if it's similar enough to be a problem.
 *  Overlap coefficient (shared / smaller set), so a 6-stop option nested inside
 *  a 30-stop one still reads as a duplicate. */
function nearestTwin(
  plan: Itinerary,
  all: Itinerary[]
): { plan: Itinerary; overlap: number; shared: number; total: number } | null {
  const ids = (p: Itinerary) =>
    new Set(p.days.flatMap((d) => (d.stops ?? []).map((s) => s.spotId)));
  const mine = ids(plan);
  if (mine.size < 4) return null;
  let worst: { plan: Itinerary; overlap: number; shared: number; total: number } | null =
    null;
  for (const other of all) {
    if (other.id === plan.id) continue;
    const theirs = ids(other);
    if (theirs.size < 4) continue;
    const shared = [...mine].filter((id) => theirs.has(id)).length;
    const overlap = shared / Math.min(mine.size, theirs.size);
    if (overlap > 0.7 && (!worst || overlap > worst.overlap)) {
      worst = { plan: other, overlap, shared, total: Math.min(mine.size, theirs.size) };
    }
  }
  return worst;
}

/** How many days actually differ, by content rather than identity. */
function countChangedDays(before: Itinerary, after: Itinerary): number {
  const key = (d: Itinerary["days"][number]) =>
    JSON.stringify([
      d.theme,
      d.rationale,
      (d.stops ?? []).map((s) => [s.spotId, s.time, s.durationMin, s.why]),
    ]);
  const prev = before.days.map(key);
  const next = after.days.map(key);
  let changed = Math.abs(prev.length - next.length);
  for (let i = 0; i < Math.min(prev.length, next.length); i++) {
    if (prev[i] !== next[i]) changed++;
  }
  return changed;
}

/** Plan ids are model-authored and end up in a localStorage key and a React
 *  key, so tame them: lowercase, kebab, bounded. An id that sanitizes to
 *  nothing gets a stable random one — a new option, which is the safe reading
 *  of "the model sent something we can't match". */
function slugPlanId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `plan-${Math.random().toString(36).slice(2, 8)}`;
}

/** Spot ids not referenced by any day — the "Unassigned" bucket. */
export function unassignedSpotIds(itinerary: Itinerary, spots: Spot[]): string[] {
  const planned = new Set(
    itinerary.days.flatMap((d) => d.stops.map((s) => s.spotId))
  );
  return spots.filter((s) => !planned.has(s.id)).map((s) => s.id);
}

// --- Persistence (client-side only) ---
// Your own trips carry the plans on the Trip object (round-trips through
// tripStore). Sample/shared trips are someone else's and read-only, so a
// visitor's plans live in a localStorage overlay keyed by trip id.

/** Legacy overlay: ONE Itinerary, from before a trip could hold options. */
const OVERLAY_PREFIX = "pinned.itin.";
/** Current overlay: the option list. */
const PLANS_PREFIX = "pinned.itins.";

/** Give every option the identity the UI and the agent index it by. Only
 *  plans written before options existed arrive without one. */
function withIdentity(plan: Itinerary, i: number): Itinerary {
  if (plan.id && plan.title) return plan;
  return {
    ...plan,
    id: plan.id || `plan-${i + 1}`,
    title: plan.title || (i === 0 ? "Plan 1" : `Plan ${i + 1}`),
  };
}

/** The option list from whatever shape the trip arrived in: `itineraries`
 *  (current) or the pre-options single `itinerary` (legacy, folded in as the
 *  first option). Junk entries are dropped rather than allowed to blank the
 *  rail. */
export function normalizePlans(
  raw: Itinerary[] | undefined | null,
  legacy?: Itinerary
): Itinerary[] {
  const list = raw?.length ? raw : legacy ? [legacy] : [];
  return list
    .filter((p): p is Itinerary => Boolean(p) && Array.isArray(p.days))
    .slice(0, MAX_PLANS)
    .map(withIdentity);
}

export function loadPlans(trip: Trip, isLocal: boolean): Itinerary[] {
  if (isLocal) return normalizePlans(trip.itineraries, trip.itinerary);
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(PLANS_PREFIX + trip.id);
    if (raw) return normalizePlans(JSON.parse(raw) as Itinerary[]);
    const legacy = localStorage.getItem(OVERLAY_PREFIX + trip.id);
    return legacy ? normalizePlans(null, JSON.parse(legacy) as Itinerary) : [];
  } catch {
    return [];
  }
}

export function savePlans(
  tripId: string,
  isLocal: boolean,
  plans: Itinerary[]
): void {
  if (isLocal) {
    const trip = peekTrip(tripId);
    if (trip) {
      trip.itineraries = plans;
      // Migrate, don't mirror: two fields holding a plan is two answers to
      // "what's the itinerary". `normalizePlans` still reads the old one for
      // trips that haven't been touched since.
      delete trip.itinerary;
      void saveTrip(trip);
    }
    return;
  }
  try {
    localStorage.setItem(PLANS_PREFIX + tripId, JSON.stringify(plans));
    localStorage.removeItem(OVERLAY_PREFIX + tripId);
  } catch {
    // quota exceeded — the in-memory copy still renders for this session
  }
}

/** Insert or replace ONE option and persist the whole list.
 *
 *  Reads the current list back from storage rather than taking it as an
 *  argument, because the model can land two `update_itinerary` calls in a
 *  single turn ("build me both shapes") and React state won't have caught up
 *  between them — the second write would drop the first. */
export function upsertPlan(
  trip: Trip,
  isLocal: boolean,
  plan: Itinerary
): { plans: Itinerary[]; created: boolean; rejected?: string } {
  const live = isLocal ? (peekTrip(trip.id) ?? trip) : trip;
  const plans = loadPlans(live, isLocal);
  const at = plans.findIndex((p) => p.id === plan.id);
  if (at === -1 && plans.length >= MAX_PLANS) {
    // Refuse rather than guess. Silently replacing an option the traveler is
    // comparing is the one unrecoverable outcome here; the model gets the
    // valid ids back and can retry in the same turn.
    return {
      plans,
      created: false,
      rejected: `This trip already has the maximum of ${MAX_PLANS} options, so "${plan.id}" wasn't created. Either reuse one of these ids to replace an option — ${plans
        .map((p) => `${p.id} ("${p.title}")`)
        .join(", ")} — or discard one first with discard_plan.`,
    };
  }
  const next = at === -1 ? [...plans, plan] : plans.map((p, i) => (i === at ? plan : p));
  savePlans(trip.id, isLocal, next);
  return { plans: next, created: at === -1 };
}

export function discardPlan(
  trip: Trip,
  isLocal: boolean,
  planId: string
): { plans: Itinerary[]; removed: Itinerary | null } {
  const live = isLocal ? (peekTrip(trip.id) ?? trip) : trip;
  const plans = loadPlans(live, isLocal);
  const removed = plans.find((p) => p.id === planId) ?? null;
  if (!removed) return { plans, removed: null };
  const next = plans.filter((p) => p.id !== planId);
  savePlans(trip.id, isLocal, next);
  return { plans: next, removed };
}

// Which option is on screen is VIEW state, not trip data: putting it on the
// Trip would mean a network PUT on every tab click for signed-in users (§2c),
// and "the one I was last looking at" is honestly per-device. So it lives in
// localStorage in every mode, next to the other per-browser overlays.
const ACTIVE_PLAN_PREFIX = "pinned.plan.";

export function loadActivePlanId(tripId: string): string | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    return localStorage.getItem(ACTIVE_PLAN_PREFIX + tripId);
  } catch {
    return null;
  }
}

export function saveActivePlanId(tripId: string, planId: string | null): void {
  try {
    if (planId) localStorage.setItem(ACTIVE_PLAN_PREFIX + tripId, planId);
    else localStorage.removeItem(ACTIVE_PLAN_PREFIX + tripId);
  } catch {
    // quota exceeded — the selection still holds for this session
  }
}

/** The option the traveler is looking at. Falls back to the first one, so a
 *  stale selection (an option the agent discarded) never blanks the rail. */
export function activePlan(
  plans: Itinerary[],
  activeId: string | null
): Itinerary | null {
  if (plans.length === 0) return null;
  return plans.find((p) => p.id === activeId) ?? plans[0];
}

// --- Must-see spots (user-starred; the agent must include them) ---
// Stored separately from the itinerary because the agent replaces the
// itinerary wholesale — stars are the user's, not the agent's, to overwrite.

const MUSTSEE_PREFIX = "pinned.mustsee.";

export function loadMustSees(tripId: string): string[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(MUSTSEE_PREFIX + tripId);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveMustSees(tripId: string, spotIds: string[]): void {
  try {
    localStorage.setItem(MUSTSEE_PREFIX + tripId, JSON.stringify(spotIds));
  } catch {
    // quota exceeded — in-memory state still drives this session
  }
}

// --- Geo helpers ---

export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Straight-line estimate → rough door-to-door minutes.
 *
 * The old version used one city speed (18 km/h) for every distance, which is
 * right for crossing a city and badly wrong for the drives that actually shape a
 * trip: it turned a 2h15 highway run from Udawalawe to Weligama into something
 * closer to four hours. The agent noticed, said so in its own reasoning — "those
 * straight-line estimates run high for these coastal/highway routes" — and then
 * planned around its own guess instead. A tool the agent overrules is the worst
 * of both worlds: it costs a round trip and buys nothing.
 *
 * So speed now scales with distance, the way real journeys do — short hops are
 * city traffic, long ones are mostly highway — and the detour factor shrinks as
 * roads straighten out. Still an estimate; `/api/routes` replaces it with real
 * road times when a Google key is configured.
 */
export function travelEstimate(km: number): { walkMin: number; driveMin: number } {
  // Detour factor: dense street grids wander, highways don't.
  const detour = km < 5 ? 1.35 : km < 30 ? 1.25 : 1.15;
  const routeKm = km * detour;
  // Effective door-to-door speed including stops, junctions and parking.
  const kmh = km < 3 ? 16 : km < 10 ? 24 : km < 40 ? 42 : 55;
  return {
    walkMin: Math.round((km * 1.35 / 4.5) * 60),
    driveMin: Math.max(5, Math.round((routeKm / kmh) * 60)),
  };
}

// --- Trip context sent to the chat route (client → server, stateless) ---

export interface CompactSpot {
  id: string;
  name: string;
  category: string;
  desc: string;
  lat: number;
  lng: number;
  mentions: number;
  tips?: string[];
}

export interface PlannerContext {
  tripName: string;
  destination: string | null;
  startDate?: string;
  endDate?: string;
  interests?: string;
  /** Who's going ("couple", "family", …) — set from the trip header. */
  party?: string;
  spots: CompactSpot[];
  /** Every plan option, oldest first — the agent builds and edits these side
   *  by side. Empty until it has planned anything. */
  plans: Itinerary[];
  /** Which option the traveler currently has open in the rail. */
  activePlanId?: string;
  /** Spot ids the user starred as non-negotiable must-sees. */
  mustSeeSpotIds?: string[];
}

export function buildPlannerContext(
  trip: Trip,
  plans: Itinerary[],
  activePlanId: string | null,
  mustSeeSpotIds: string[] = []
): PlannerContext {
  return {
    tripName: trip.name,
    destination: trip.destination?.name ?? null,
    startDate: trip.query?.startDate,
    endDate: trip.query?.endDate,
    interests: trip.query?.interests,
    party: trip.query?.party,
    mustSeeSpotIds: mustSeeSpotIds.length > 0 ? mustSeeSpotIds : undefined,
    // Out-of-bounds spots are held back from the agent as well as the map: a
    // planner that can see Svaneti on a Tbilisi weekend will eventually put it
    // in a day, and the traveler finds out it's nine hours away.
    spots: trip.spots
      .filter((s) => !s.outOfBounds || mustSeeSpotIds.includes(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        desc: s.description.slice(0, 160),
        lat: s.lat,
        lng: s.lng,
        mentions: s.mentions.length,
        tips: s.thingsToKnow?.slice(0, 3).map((t) => t.slice(0, 120)),
      })),
    plans,
    activePlanId: activePlanId ?? undefined,
  };
}

/** One line per spot with its 3 nearest neighbors — lets the model cluster
 *  days geographically without a tool round-trip per pair. */
export function spotDigest(spots: CompactSpot[]): string {
  return spots
    .map((s) => {
      const nearest = spots
        .filter((o) => o.id !== s.id)
        .map((o) => ({ id: o.id, km: haversineKm(s.lat, s.lng, o.lat, o.lng) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 3)
        .map((n) => `${n.id}(${n.km.toFixed(1)}km)`)
        .join(" ");
      const tips = s.tips?.length ? ` | tips: ${s.tips.join("; ")}` : "";
      return `${s.id} | ${s.name} | ${s.category} | ${s.mentions} creator${
        s.mentions === 1 ? "" : "s"
      } | ${s.desc}${tips} | near: ${nearest}`;
    })
    .join("\n");
}

/** Day colors for the map whiteboard — distinct, readable on the pastel map. */
export const DAY_COLORS = [
  "#e05252", // red
  "#2e7dd1", // blue
  "#2f9e63", // green
  "#b3599e", // purple
  "#e08e2e", // orange
  "#1fa4a4", // teal
  "#8a6ddf", // violet
  "#c2764a", // brown
  "#d14f86", // pink
  "#5f7d2f", // olive
  "#4a63c2", // indigo
  "#9e8b2f", // mustard
  "#3b8ea5", // steel
  "#a5533b", // rust
];

export function dayColor(i: number): string {
  return DAY_COLORS[i % DAY_COLORS.length];
}
