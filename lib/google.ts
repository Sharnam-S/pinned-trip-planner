/**
 * Google Places API (New) — precise POI coordinates and real place photos.
 * Used ahead of Nominatim/Wikimedia whenever GOOGLE_MAPS_API_KEY is set
 * (enable "Places API (New)" on the key). Server-side only.
 */

export function isGoogleEnabled(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

function apiKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY!;
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

export interface GooglePlace {
  id: string;
  lat: number;
  lng: number;
  /** Places photo resource names (places/…/photos/…), best first. */
  photoNames: string[];
}

/**
 * Text Search biased to the LLM's rough coordinates. Same sanity rule as the
 * Nominatim path: a hit only counts if it lands within 150km of the bias, so a
 * same-name place on another continent can't hijack the pin.
 */
export async function googleFindPlace(
  query: string,
  biasLat: number,
  biasLng: number
): Promise<GooglePlace | null> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": "places.id,places.location,places.photos",
    },
    body: JSON.stringify({
      textQuery: query,
      pageSize: 3,
      locationBias: {
        circle: {
          center: { latitude: biasLat, longitude: biasLng },
          radius: 50000.0, // API maximum
        },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Places searchText ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    places?: {
      id: string;
      location?: { latitude: number; longitude: number };
      photos?: { name: string }[];
    }[];
  };

  for (const p of data.places ?? []) {
    if (!p.location) continue;
    const { latitude: lat, longitude: lng } = p.location;
    if (distanceKm(lat, lng, biasLat, biasLng) > 150) continue;
    return { id: p.id, lat, lng, photoNames: (p.photos ?? []).map((ph) => ph.name) };
  }
  return null;
}

/** Photo resource names for an already-resolved place id. */
export async function googlePlacePhotoNames(placeId: string): Promise<string[]> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": "photos",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Place details ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { photos?: { name: string }[] };
  return (data.photos ?? []).map((p) => p.name);
}

/**
 * Resolves a Places photo resource name to a stable image URL
 * (lh3.googleusercontent.com). One billed Photos call per spot, at creation
 * time only — the returned URI is rendered directly by <img>.
 */
export async function googlePhotoUrl(photoName: string): Promise<string | null> {
  const url =
    `https://places.googleapis.com/v1/${photoName}/media` +
    `?maxWidthPx=800&skipHttpRedirect=true&key=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Places photo media ${res.status}`);
  }
  const data = (await res.json()) as { photoUri?: string };
  return data.photoUri ?? null;
}
