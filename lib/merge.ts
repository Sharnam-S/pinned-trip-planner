/**
 * Pure trip-mutation helpers shared by the browser runner (localStorage trips)
 * and the server pipeline. No fs, no API clients — safe in both bundles.
 */
import { Destination, Mention, Spot, Trip, TripQuery, TripVideo } from "./types";

export function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function mergeThingsToKnow(spot: Spot, incoming: string[] | undefined) {
  if (!incoming?.length) return;
  const seen = new Set((spot.thingsToKnow ?? []).map(normalizeName));
  spot.thingsToKnow = [
    ...(spot.thingsToKnow ?? []),
    ...incoming.filter((t) => !seen.has(normalizeName(t))),
  ].slice(0, 8);
}

export function newSearchTrip(id: string, query: TripQuery): Trip {
  return {
    id,
    name: query.destination,
    destination: null,
    createdAt: new Date().toISOString(),
    status: "processing",
    progress: "Planning YouTube searches…",
    videos: [],
    spots: [],
    query,
  };
}

export function pendingVideo(id: string, title = "", channelName = ""): TripVideo {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    channelName,
    channelAvatar: "",
    // Derived from the id, not left blank until the video is read: a build shows
    // its whole curated lineup for minutes, and an empty string meant twenty
    // grey rectangles that looked like broken images. /api/process-video
    // replaces this with the maxres art once it has read the video.
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    status: "pending" as const,
  };
}

/** What POST /api/process-video returns: one video fully read and resolved. */
export interface VideoResult {
  video: {
    id: string;
    url: string;
    title: string;
    channelName: string;
    channelAvatar: string;
    thumbnail: string;
    spotCount: number;
  };
  destination: Destination;
  /** Spots not in knownSpotNames — fully resolved (coords, placeId, photos). */
  newSpots: Spot[];
  /** Mentions of spots the trip already has, to merge by name. */
  knownMentions: { name: string; mention: Mention; thingsToKnow?: string[] }[];
}

/**
 * Trip-independent read of one video: video metadata plus EVERY spot it
 * discusses, fully resolved (coords, placeId, cover photo). This is what gets
 * cached and shared across trips — two people whose Sri Lanka trips include the
 * same video reuse this instead of re-fetching the transcript and re-billing
 * Claude + Google. Re-partition it per trip with `partitionCachedVideo`.
 */
export interface CachedVideo {
  /** Bump when the resolved shape changes so stale caches are re-processed. */
  version: number;
  cachedAt: string;
  video: VideoResult["video"];
  destination: Destination;
  /** Every spot the video discusses, each with its own mention. */
  spots: Spot[];
}

/**
 * Split a cached (trip-independent) video into the newSpots / knownMentions a
 * specific trip needs: spots the trip already has fold in as mentions, the rest
 * are new. Pure and uses the same name matching `processVideo` did, so a cache
 * hit yields exactly what a fresh run with these `knownSpotNames` would have.
 */
export function partitionCachedVideo(
  cached: CachedVideo,
  knownSpotNames: string[]
): VideoResult {
  const known = new Set(knownSpotNames.map(normalizeName));
  const newSpots: Spot[] = [];
  const knownMentions: VideoResult["knownMentions"] = [];
  for (const spot of cached.spots) {
    if (known.has(normalizeName(spot.name))) {
      knownMentions.push({
        name: spot.name,
        // A cached spot's mentions are all from this one video, so the first
        // carries this video's reference (the merge dedupes by videoId anyway).
        mention: spot.mentions[0],
        thingsToKnow: spot.thingsToKnow,
      });
    } else {
      newSpots.push(spot);
    }
  }
  return {
    video: cached.video,
    destination: cached.destination,
    newSpots,
    knownMentions,
  };
}

/** Folds one processed video into the trip. Returns # of spots added. */
export function applyVideoResult(trip: Trip, result: VideoResult): number {
  const video = trip.videos.find((v) => v.id === result.video.id);
  if (video) {
    Object.assign(video, result.video, { status: "done" as const });
  }
  if (!trip.destination) {
    trip.destination = result.destination;
    if (trip.name === "Untitled trip") trip.name = result.destination.name;
  }

  let added = 0;
  for (const spot of result.newSpots) {
    const existing = trip.spots.find(
      (s) => normalizeName(s.name) === normalizeName(spot.name)
    );
    if (existing) {
      // server couldn't know another video in this batch already added it
      mergeMention(existing, spot.mentions[0], spot.thingsToKnow);
      continue;
    }
    trip.spots.push(spot);
    added++;
  }
  for (const k of result.knownMentions) {
    const existing = trip.spots.find(
      (s) => normalizeName(s.name) === normalizeName(k.name)
    );
    if (existing) mergeMention(existing, k.mention, k.thingsToKnow);
  }
  return added;
}

function mergeMention(spot: Spot, mention: Mention | undefined, tips?: string[]) {
  if (mention && !spot.mentions.some((m) => m.videoId === mention.videoId)) {
    spot.mentions.push(mention);
  }
  mergeThingsToKnow(spot, tips);
}
