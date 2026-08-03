/**
 * Real road times, when we can get them.
 *
 * The planner's `get_travel_times` tool was straight-line-based, and the agent
 * didn't believe it — it called the tool and then overrode the answer from its
 * own knowledge, out loud, in its reasoning. Either the number is trustworthy
 * enough to plan a day around or the tool shouldn't exist; "3h 10m drive" is a
 * fact travellers arrange flights around.
 *
 * Google's Routes API `computeRouteMatrix` prices per element (origin × dest),
 * so we only ever ask about the ADJACENT pairs a day actually contains — never
 * a full matrix. A 6-stop day is 5 elements; the free tier covers ordinary use
 * comfortably. No key configured → the caller falls back to the estimate, which
 * is why this returns nulls rather than throwing.
 */

export interface RoutePair {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
}

const FIELD_MASK =
  "originIndex,destinationIndex,duration,distanceMeters,condition";

export function routesEnabled(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

/**
 * Driving minutes per pair, positionally aligned with the input. `null` where
 * Google couldn't route it (islands, ferries, a coordinate in the sea) so the
 * caller can fall back per-pair rather than discarding the whole answer.
 */
export async function drivingMinutes(
  pairs: RoutePair[]
): Promise<(number | null)[]> {
  if (!routesEnabled() || pairs.length === 0) return pairs.map(() => null);

  // One request per pair keeps the element count exactly equal to the number of
  // legs we care about. Batching them into a matrix would bill every
  // origin×destination combination, most of which nobody asked about.
  const results = await Promise.all(
    pairs.map(async (pair) => {
      try {
        const res = await fetch(
          "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY!,
              "X-Goog-FieldMask": FIELD_MASK,
            },
            body: JSON.stringify({
              origins: [
                {
                  waypoint: {
                    location: {
                      latLng: { latitude: pair.from.lat, longitude: pair.from.lng },
                    },
                  },
                },
              ],
              destinations: [
                {
                  waypoint: {
                    location: {
                      latLng: { latitude: pair.to.lat, longitude: pair.to.lng },
                    },
                  },
                },
              ],
              travelMode: "DRIVE",
              routingPreference: "TRAFFIC_UNAWARE",
            }),
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) return null;
        const rows = (await res.json()) as {
          duration?: string;
          condition?: string;
        }[];
        const row = rows.find((r) => r.condition === "ROUTE_EXISTS") ?? rows[0];
        const seconds = Number(String(row?.duration ?? "").replace("s", ""));
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        return Math.round(seconds / 60);
      } catch {
        // A routing failure must never fail a planning turn.
        return null;
      }
    })
  );
  return results;
}
