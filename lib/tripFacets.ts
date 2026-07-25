import { getLocalTrip, saveLocalTrip } from "./clientStore";
import type { Trip, TripParty, TripQuery } from "./types";

// The three questions the trip header asks: when, what you're into, and who's
// going. They start as whatever the search form collected and stay editable
// for the life of the trip — every one of them changes what the planner
// should build, so they feed straight into the agent's context.

export interface TripFacets {
  startDate?: string;
  endDate?: string;
  interests?: string;
  party?: TripParty;
}

const FACET_KEYS = ["startDate", "endDate", "interests", "party"] as const;

export const PARTY_OPTIONS: {
  value: TripParty;
  label: string;
  emoji: string;
}[] = [
  { value: "solo", label: "Solo", emoji: "🧍" },
  { value: "couple", label: "Couple", emoji: "💞" },
  { value: "friends", label: "Friends", emoji: "🥂" },
  { value: "family", label: "Family", emoji: "👨‍👩‍👧" },
  { value: "group", label: "Group", emoji: "🚌" },
];

export function partyLabel(party?: TripParty): string | null {
  return PARTY_OPTIONS.find((o) => o.value === party)?.label ?? null;
}

/** "Aug 3 – Aug 9", or a single date, or null when neither end is set. */
export function formatDateRange(startDate?: string, endDate?: string): string | null {
  if (!startDate && !endDate) return null;
  // Parsed as local noon-free midnight — never `new Date("2026-07-17")`, which
  // is UTC and shifts the day west of Greenwich.
  const fmt = (iso: string) =>
    new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  if (startDate && endDate) return `${fmt(startDate)} – ${fmt(endDate)}`;
  return fmt((startDate ?? endDate)!);
}

// --- Persistence (client-side only) ---
// Mirrors the itinerary: a trip you own carries its facets on trip.query, and
// a sample/shared trip is server-owned, so a visitor's answers live in a
// localStorage overlay keyed by trip id. Cleared fields are stored as null —
// JSON.stringify drops `undefined`, so without the null the underlying
// trip.query value would come back on the next load.

const FACETS_PREFIX = "pinned.facets.";

type StoredFacets = { [K in keyof TripFacets]?: TripFacets[K] | null };

export function loadFacets(trip: Trip): TripFacets {
  const q = trip.query;
  const base: TripFacets = {
    startDate: q?.startDate,
    endDate: q?.endDate,
    interests: q?.interests,
    party: q?.party,
  };
  if (typeof window === "undefined" || !window.localStorage) return base;
  let overlay: StoredFacets | null = null;
  try {
    const raw = localStorage.getItem(FACETS_PREFIX + trip.id);
    overlay = raw ? (JSON.parse(raw) as StoredFacets) : null;
  } catch {
    overlay = null;
  }
  if (!overlay) return base;
  const merged: TripFacets = { ...base };
  for (const key of FACET_KEYS) {
    if (key in overlay) {
      // null = the visitor cleared it; undefined = never answered.
      (merged[key] as unknown) = overlay[key] ?? undefined;
    }
  }
  return merged;
}

export function saveFacets(
  tripId: string,
  isLocal: boolean,
  facets: TripFacets
): void {
  if (isLocal) {
    const trip = getLocalTrip(tripId);
    if (trip) {
      trip.query = withFacets(trip, facets);
      saveLocalTrip(trip);
    }
    return;
  }
  const stored: StoredFacets = {};
  for (const key of FACET_KEYS) {
    (stored[key] as unknown) = facets[key] ?? null;
  }
  try {
    localStorage.setItem(FACETS_PREFIX + tripId, JSON.stringify(stored));
  } catch {
    // quota exceeded — the in-memory copy still drives this session
  }
}

/** The trip as the planner should see it: stored query plus the answers the
 *  user has since edited in the header. */
export function applyFacets(trip: Trip, facets: TripFacets): Trip {
  return { ...trip, query: withFacets(trip, facets) };
}

function withFacets(trip: Trip, facets: TripFacets): TripQuery {
  return {
    // A trip built from pasted links has no query at all; the destination is
    // required, so seed it from what we know.
    destination: trip.query?.destination ?? trip.destination?.name ?? trip.name,
    ...trip.query,
    ...facets,
  };
}
