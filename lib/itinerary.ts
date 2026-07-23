/**
 * The planner agent's itinerary: zod schemas shared by the chat route (tool
 * definitions) and the client (validation before saving), plus persistence
 * and geo helpers. The itinerary is a data object the agent edits via the
 * update_itinerary tool — never prose in the chat.
 */
import { z } from "zod";
import { Itinerary, ItinerarySlot, Spot, Trip } from "./types";
import { getLocalTrip, saveLocalTrip } from "./clientStore";

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

export const ItineraryInputSchema = z.object({
  days: z
    .array(
      z.object({
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
      })
    )
    .describe("The full plan — this replaces the previous itinerary entirely"),
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

const MAX_DAYS = 14;
const MAX_STOPS_PER_DAY = 10;

/** Normalize a model-sent itinerary against the trip's real spots: drop
 *  unknown ids and duplicates (first occurrence wins), cap sizes. Warnings go
 *  back to the model in the tool result so it can self-correct. */
export function validateItinerary(
  input: ItineraryInput,
  spots: Spot[]
): { itinerary: Itinerary; warnings: string[] } {
  const known = new Set(spots.map((s) => s.id));
  const seen = new Set<string>();
  const warnings: string[] = [];

  if (input.days.length > MAX_DAYS) {
    warnings.push(`Plan capped at ${MAX_DAYS} days.`);
  }

  const days = input.days.slice(0, MAX_DAYS).map((day, i) => {
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
      days,
      stay: input.stay,
      pace: input.pace,
      budget: input.budget,
      updatedAt: new Date().toISOString(),
    },
    warnings,
  };
}

/** Spot ids not referenced by any day — the "Unassigned" bucket. */
export function unassignedSpotIds(itinerary: Itinerary, spots: Spot[]): string[] {
  const planned = new Set(
    itinerary.days.flatMap((d) => d.stops.map((s) => s.spotId))
  );
  return spots.filter((s) => !planned.has(s.id)).map((s) => s.id);
}

// --- Persistence (client-side only) ---
// Local trips carry the itinerary on the Trip object (round-trips through
// saveLocalTrip). Sample/shared trips are server-owned and read-only, so a
// visitor's plan lives in a localStorage overlay keyed by trip id.

const OVERLAY_PREFIX = "pinned.itin.";

export function loadItinerary(trip: Trip, isLocal: boolean): Itinerary | null {
  if (isLocal) return trip.itinerary ?? null;
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = localStorage.getItem(OVERLAY_PREFIX + trip.id);
    return raw ? (JSON.parse(raw) as Itinerary) : null;
  } catch {
    return null;
  }
}

export function saveItinerary(
  tripId: string,
  isLocal: boolean,
  itinerary: Itinerary
): void {
  if (isLocal) {
    const trip = getLocalTrip(tripId);
    if (trip) {
      trip.itinerary = itinerary;
      saveLocalTrip(trip);
    }
    return;
  }
  try {
    localStorage.setItem(OVERLAY_PREFIX + tripId, JSON.stringify(itinerary));
  } catch {
    // quota exceeded — the in-memory copy still renders for this session
  }
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

/** Straight-line estimate → rough door-to-door minutes. City routes aren't
 *  straight lines, so pad distance by 1.3; walking 4.5km/h, driving/transit
 *  ~18km/h city average incl. waiting. Good enough for day planning. */
export function travelEstimate(km: number): { walkMin: number; driveMin: number } {
  const routeKm = km * 1.3;
  return {
    walkMin: Math.round((routeKm / 4.5) * 60),
    driveMin: Math.max(5, Math.round((routeKm / 18) * 60)),
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
  spots: CompactSpot[];
  itinerary: Itinerary | null;
  /** Spot ids the user starred as non-negotiable must-sees. */
  mustSeeSpotIds?: string[];
}

export function buildPlannerContext(
  trip: Trip,
  itinerary: Itinerary | null,
  mustSeeSpotIds: string[] = []
): PlannerContext {
  return {
    tripName: trip.name,
    destination: trip.destination?.name ?? null,
    startDate: trip.query?.startDate,
    endDate: trip.query?.endDate,
    interests: trip.query?.interests,
    mustSeeSpotIds: mustSeeSpotIds.length > 0 ? mustSeeSpotIds : undefined,
    spots: trip.spots.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      desc: s.description.slice(0, 160),
      lat: s.lat,
      lng: s.lng,
      mentions: s.mentions.length,
      tips: s.thingsToKnow?.slice(0, 3).map((t) => t.slice(0, 120)),
    })),
    itinerary,
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
