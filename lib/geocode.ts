/**
 * Geocoding via OpenStreetMap Nominatim (free, no key, 1 req/sec policy).
 * The LLM's best-guess coordinates act as both a sanity check and a fallback:
 * Nominatim wins only if its result lands within 150km of the LLM guess,
 * which filters out same-name places in the wrong country.
 */

let lastRequest = 0;

async function rateLimit() {
  const wait = 1100 - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * The destination's own extent, so the trip knows what "here" means.
 *
 * Nominatim returns a `boundingbox` for administrative places, which is exactly
 * the right shape: a city gets a city, a country gets a country. We pad it a
 * little because travel spills over borders in ways an admin boundary doesn't —
 * a beach ten minutes outside the city limit is still part of a city trip.
 *
 * Returns null when the place can't be resolved; callers must treat that as
 * "no bounds known" and keep every spot rather than guessing a box.
 */
export async function geocodeBounds(
  query: string
): Promise<{ bounds: [[number, number], [number, number]]; scale: "city" | "region" | "country" } | null> {
  try {
    await rateLimit();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "youtube-trip-planner/1.0 (local hobby project)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const results = (await res.json()) as {
      boundingbox?: [string, string, string, string];
      addresstype?: string;
      type?: string;
    }[];
    const box = results[0]?.boundingbox;
    if (!box) return null;
    const [south, north, west, east] = box.map(Number);
    if ([south, north, west, east].some((n) => !Number.isFinite(n))) return null;

    // Pad by 15% of each span, floored at ~10km, so a spot just over the line
    // isn't quarantined for being on the wrong side of an admin boundary.
    const padLat = Math.max((north - south) * 0.15, 0.09);
    const padLng = Math.max((east - west) * 0.15, 0.09);

    const span = Math.max(north - south, east - west);
    const scale = span > 4 ? "country" : span > 0.6 ? "region" : "city";

    return {
      bounds: [
        [south - padLat, west - padLng],
        [north + padLat, east + padLng],
      ],
      scale,
    };
  } catch {
    return null;
  }
}

export async function geocode(
  query: string,
  llmLat: number,
  llmLng: number
): Promise<{ lat: number; lng: number; source: "nominatim" | "llm" }> {
  try {
    await rateLimit();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "youtube-trip-planner/1.0 (local hobby project)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const results = (await res.json()) as { lat: string; lon: string }[];

    for (const r of results) {
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lon);
      if (distanceKm(lat, lng, llmLat, llmLng) <= 150) {
        return { lat, lng, source: "nominatim" };
      }
    }
  } catch {
    // fall through to LLM coords
  }
  return { lat: llmLat, lng: llmLng, source: "llm" };
}
