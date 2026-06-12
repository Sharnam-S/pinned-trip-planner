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
    thumbnail: "",
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
