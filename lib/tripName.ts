import { peekTrip, saveTrip } from "./tripStore";
import type { Trip } from "./types";

// A trip is born named after where it's going, and the runner overwrites that
// name once the planner resolves the destination ("sri lanka" → "Sri Lanka").
// A rename can't live in that field, then: it would be clobbered mid-build,
// and `name` is also what the flag, the planner context and the LLM traces
// read. So a user-typed title is a separate `label` laid over the top —
// nothing downstream of `name` changes when it's set.

/** Longest title we'll store. Roughly a header's worth of text; the API caps
 *  it again on the way in (lib/validateTrip.ts). */
export const MAX_TRIP_LABEL = 120;

const NAME_PREFIX = "pinned.name.";

/** The title to show for a trip: what the user called it, else where it goes. */
export function tripLabel(trip: Trip): string {
  return trip.label?.trim() || trip.name;
}

/** As `tripLabel`, plus the per-browser overlay a visitor's rename of a
 *  sample/shared trip lives in. Client-only. */
export function loadTripLabel(trip: Trip): string {
  if (trip.label?.trim()) return trip.label.trim();
  if (typeof window === "undefined" || !window.localStorage) return trip.name;
  try {
    const stored = localStorage.getItem(NAME_PREFIX + trip.id)?.trim();
    if (stored) return stored;
  } catch {
    // storage disabled — the stored name is a nicety, the destination isn't
  }
  return trip.name;
}

/**
 * Write a rename through. Mirrors `saveFacets`: a trip you own carries the
 * label on the Trip itself, and a sample/shared trip is server-owned, so a
 * visitor's title lives in a localStorage overlay keyed by trip id.
 *
 * An empty label means "go back to the destination name" — the field and the
 * overlay are both removed rather than stored blank.
 */
export function saveTripLabel(
  tripId: string,
  isLocal: boolean,
  label: string
): void {
  const next = label.trim().slice(0, MAX_TRIP_LABEL);
  if (isLocal) {
    const trip = peekTrip(tripId);
    if (!trip) return;
    if (next) trip.label = next;
    else delete trip.label;
    void saveTrip(trip);
    return;
  }
  try {
    if (next) localStorage.setItem(NAME_PREFIX + tripId, next);
    else localStorage.removeItem(NAME_PREFIX + tripId);
  } catch {
    // quota exceeded — the in-memory copy still drives this session
  }
}
