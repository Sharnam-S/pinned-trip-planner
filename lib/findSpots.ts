/**
 * Mid-chat spot discovery: the `find_spots` agent tool runs this when the user
 * wants pins the trip doesn't have yet (a new area or interest). It's a scoped
 * mini-runner — the same pipeline as trip creation (`lib/runner.ts`), narrowed
 * to a sub-query and capped to a few videos. Stateless server, browser owns the
 * data: it reuses /api/discover + /api/process-video and merges into
 * localStorage, so the map re-renders via the trip subscription (no callback).
 */
import { getLocalTrip, saveLocalTrip } from "./clientStore";
import { applyVideoResult, pendingVideo, VideoResult } from "./merge";

/** A day's worth is plenty — keeps it fast (~20-30s) and quota-cheap. */
const FIND_VIDEOS = 4;

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
): Promise<{ added: number; spots: FoundSpot[] }> {
  const trip0 = getLocalTrip(tripId);
  if (!trip0) return { added: 0, spots: [] };

  onProgress(`Searching ${query.destination}…`);
  const plan = await post<{
    videos: { id: string; title: string; channelName: string }[];
  }>("/api/discover", {
    destination: query.destination,
    interests: query.interests,
    tripId,
    tripName: trip0.name,
  });

  const picks = plan.videos.slice(0, FIND_VIDEOS);
  if (picks.length === 0) return { added: 0, spots: [] };

  // Snapshot what we already have (for dedup + the "new" diff), and register
  // the picked videos so their spot mentions link to real sources.
  const before = new Set(trip0.spots.map((s) => s.id));
  const knownSpotNames = trip0.spots.map((s) => s.name);
  const withVideos = getLocalTrip(tripId);
  if (!withVideos) return { added: 0, spots: [] };
  for (const v of picks) {
    if (!withVideos.videos.some((x) => x.id === v.id)) {
      withVideos.videos.push(pendingVideo(v.id, v.title, v.channelName));
    }
  }
  saveLocalTrip(withVideos);

  onProgress(`Reading ${picks.length} videos…`);
  let done = 0;
  const bump = () => onProgress(`Read ${++done}/${picks.length} videos…`);
  // Fetch in parallel (fast), then apply all at once on one trip object (no
  // read-modify-write race across the concurrent calls).
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
        // A caption-less or unreadable video just contributes nothing.
        .catch(() => {
          bump();
          return null;
        })
    )
  );

  const trip = getLocalTrip(tripId);
  if (!trip) return { added: 0, spots: [] };
  for (const r of results) if (r) applyVideoResult(trip, r);
  saveLocalTrip(trip);

  const newSpots = trip.spots.filter((s) => !before.has(s.id));
  return {
    added: newSpots.length,
    spots: newSpots.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
    })),
  };
}
