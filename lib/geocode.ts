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
