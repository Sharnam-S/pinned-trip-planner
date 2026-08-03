/**
 * Mid-chat spot discovery: the `find_spots` agent tool runs this when the user
 * wants pins the trip doesn't have yet (a new area or interest). It's a scoped
 * mini-runner — the same pipeline as trip creation (`lib/runner.ts`), narrowed
 * to a sub-query and capped to a few videos. Stateless server, browser owns the
 * data: it reuses /api/discover + /api/process-video and merges into
 * localStorage, so the map re-renders via the trip subscription (no callback).
 */
import { peekTrip, saveTrip } from "./tripStore";
import { applyVideoResult, pendingVideo, VideoResult } from "./merge";

/** A day's worth is plenty — keeps it fast (~20-30s) and quota-cheap. */
const FIND_VIDEOS = 4;

/**
 * Discovery results for a (destination, interests) pair, for this page view.
 *
 * `/api/discover` is a Sonnet query plan + YouTube searches + a Sonnet curation
 * of 60 candidates — 22 seconds and ~$0.03 — and `find_spots` uses it to take
 * the top FOUR videos. One measured turn spent 45 of its 71 seconds on two of
 * these back to back. The agent also re-searches the same area across a
 * conversation more often than you'd think.
 */
const discoverCache = new Map<
  string,
  { videos: { id: string; title: string; channelName: string }[]; at: number }
>();
const DISCOVER_TTL_MS = 15 * 60 * 1000;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Request failed (${res.status})`
    );
  }
  return data as T;
}

export type FoundSpot = { id: string; name: string; category: string };

/**
 * Search fresh YouTube videos for `query`, read the top few, and merge any new
 * spots into the trip. Returns only the genuinely-new spots (deduped against
 * what the trip already had). `onProgress` drives the tool's status card.
 */
export async function findSpots(
  tripId: string,
  query: { destination: string; interests?: string },
  onProgress: (msg: string) => void
): Promise<{ added: number; spots: FoundSpot[]; attempted?: number; unreadable?: number }> {
  const trip0 = peekTrip(tripId);
  if (!trip0) return { added: 0, spots: [] };

  onProgress(`Searching ${query.destination}…`);
  const cacheKey = `${query.destination}|${query.interests ?? ""}`.toLowerCase();
  const cached = discoverCache.get(cacheKey);
  const fresh = cached && Date.now() - cached.at < DISCOVER_TTL_MS;
  const plan = fresh
    ? { videos: cached!.videos }
    : await post<{
        videos: { id: string; title: string; channelName: string }[];
      }>("/api/discover", {
        destination: query.destination,
        interests: query.interests,
        tripId,
        tripName: trip0.name,
      });
  if (!fresh) discoverCache.set(cacheKey, { videos: plan.videos, at: Date.now() });

  const picks = plan.videos.slice(0, FIND_VIDEOS);
  if (picks.length === 0) return { added: 0, spots: [] };

  // Snapshot what we already have (for dedup + the "new" diff), and register
  // the picked videos so their spot mentions link to real sources.
  const before = new Set(trip0.spots.map((s) => s.id));
  const knownSpotNames = trip0.spots.map((s) => s.name);
  const withVideos = peekTrip(tripId);
  if (!withVideos) return { added: 0, spots: [] };
  for (const v of picks) {
    if (!withVideos.videos.some((x) => x.id === v.id)) {
      withVideos.videos.push(pendingVideo(v.id, v.title, v.channelName));
    }
  }
  await saveTrip(withVideos);

  onProgress(`Reading ${picks.length} videos…`);
  let done = 0;
  const bump = () => onProgress(`Read ${++done}/${picks.length} videos…`);
  // Fetch in parallel (fast), then apply all at once on one trip object (no
  // read-modify-write race across the concurrent calls).
  let unreadable = 0;
  const results = await Promise.all(
    picks.map((v) =>
      post<VideoResult>("/api/process-video", {
        videoId: v.id,
        knownSpotNames,
        tripId,
        tripName: trip0.name,
      })
        .then((r) => {
          bump();
          return r;
        })
        .catch(() => {
          // Counted, not swallowed. Reporting "couldn't find good new spots"
          // when four videos were found and none could be READ told a traveler
          // there are no wine bars in Tbilisi — which is both false and exactly
          // the kind of answer that ends the relationship.
          unreadable++;
          bump();
          return null;
        })
    )
  );

  const trip = peekTrip(tripId);
  if (!trip) return { added: 0, spots: [] };
  for (const r of results) if (r) applyVideoResult(trip, r);
  await saveTrip(trip);

  const newSpots = trip.spots.filter((s) => !before.has(s.id));
  return {
    added: newSpots.length,
    attempted: picks.length,
    unreadable,
    spots: newSpots.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
    })),
  };
}
