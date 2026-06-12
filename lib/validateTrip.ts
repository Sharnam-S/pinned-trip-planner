/**
 * Minimal structural check for a Trip coming from an untrusted source
 * (the /api/publish body, an uploaded JSON file). Not a full schema — just
 * enough to reject garbage before it lands in the shared store.
 */
import { Trip } from "./types";

export function asValidTrip(input: unknown): Trip | null {
  if (!input || typeof input !== "object") return null;
  const t = input as Record<string, unknown>;
  if (typeof t.id !== "string" || !/^[\w-]{6,64}$/.test(t.id)) return null;
  if (typeof t.name !== "string" || t.name.length > 200) return null;
  if (!Array.isArray(t.spots) || !Array.isArray(t.videos)) return null;
  if (t.spots.length > 500 || t.videos.length > 100) return null;
  for (const s of t.spots) {
    if (!s || typeof s !== "object") return null;
    const spot = s as Record<string, unknown>;
    if (typeof spot.name !== "string") return null;
    if (typeof spot.lat !== "number" || typeof spot.lng !== "number") return null;
  }
  return input as Trip;
}
