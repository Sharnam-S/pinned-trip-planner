/**
 * The planner agent's itinerary: zod schemas shared by the chat route (tool
 * definitions) and the client (validation before saving), plus persistence
 * and geo helpers. The itinerary is a data object the agent edits via the
 * update_itinerary tool — never prose in the chat.
 */
import { z } from "zod";
import { Itinerary, Spot, Trip } from "./types";
import { getLocalTrip, saveLocalTrip } from "./clientStore";

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
          .optional()
          .describe('One-line theme, e.g. "Old town + street food"'),
        rationale: z
          .string()
          .optional()
          .describe(
            "1-2 sentences: why these spots are grouped and ordered this way (geography, opening hours, pacing). Shown to the user on the map."
          ),
        stops: z
          .array(
            z.object({
              spotId: z
                .string()
                .describe("A spot id from the trip context, exactly as given"),
              slot: z.enum(["morning", "afternoon", "evening"]).optional(),
              time: z
                .string()
                .optional()
                .describe('Planned arrival, 24h "HH:MM", e.g. "09:30"'),
              durationMin: z
                .number()
                .optional()
                .describe("Minutes to spend at this stop"),
              why: z
                .string()
                .optional()
                .describe(
                  "One sentence: why THIS spot on THIS day at THIS time (weekday fit, light, crowds, what it pairs with). Shown on the spot's card — fill it for every stop."
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
        slot: stop.slot,
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
