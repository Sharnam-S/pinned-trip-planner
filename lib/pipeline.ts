import crypto from "crypto";
import { getTrip, saveTrip } from "./store";
import { fetchVideoData } from "./youtube";
import { extractSpots } from "./extract";
import { geocode } from "./geocode";
import { findSpotPhoto } from "./photos";
import { Mention, Spot, Trip } from "./types";

function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Processes every video still marked "pending" in the trip, one at a time.
 * The trip file is re-saved after each video so the UI can show progress
 * and spots appearing incrementally.
 */
export async function processTrip(tripId: string): Promise<void> {
  let trip = getTrip(tripId);
  if (!trip) return;

  for (const videoRef of trip.videos.filter((v) => v.status === "pending")) {
    trip = getTrip(tripId)!;
    const video = trip.videos.find((v) => v.id === videoRef.id)!;
    video.status = "processing";
    trip.progress = `Fetching transcript: ${video.url}`;
    saveTrip(trip);

    try {
      const data = await fetchVideoData(video.id);
      video.title = data.title;
      video.channelName = data.channelName;
      video.channelAvatar = data.channelAvatar;
      video.thumbnail = data.thumbnail;
      trip.progress = `Reading "${data.title}" — extracting spots with Claude…`;
      saveTrip(trip);

      const knownNames = trip.spots.map((s) => s.name);
      const extraction = await extractSpots(data, knownNames);

      if (!trip.destination) {
        trip.destination = extraction.destination;
        if (trip.name === "Untitled trip") trip.name = extraction.destination.name;
        saveTrip(trip);
      }

      let added = 0;
      for (const raw of extraction.spots) {
        const mention: Mention = {
          videoId: data.id,
          videoTitle: data.title,
          channelName: data.channelName,
          channelAvatar: data.channelAvatar,
          timestampSec: Math.max(0, Math.floor(raw.timestamp_sec)),
          quote: raw.quote,
        };

        const existing = trip.spots.find(
          (s) => normalizeName(s.name) === normalizeName(raw.name)
        );
        if (existing) {
          if (!existing.mentions.some((m) => m.videoId === data.id)) {
            existing.mentions.push(mention);
          }
          mergeThingsToKnow(existing, raw.things_to_know);
          continue;
        }

        trip.progress = `Locating "${raw.name}" on the map…`;
        saveTrip(trip);
        const coords = await geocode(raw.geocode_query, raw.lat, raw.lng);

        const spot: Spot = {
          id: crypto.randomUUID(),
          name: raw.name,
          category: raw.category,
          description: raw.description,
          lat: coords.lat,
          lng: coords.lng,
          geocodeSource: coords.source,
          mentions: [mention],
          thingsToKnow: (raw.things_to_know ?? []).slice(0, 6),
          photo: await findSpotPhoto(raw.name, trip.destination?.name ?? null).catch(
            () => undefined // transient failure: backfill will retry on next visit
          ),
        };
        trip.spots.push(spot);
        added++;
        saveTrip(trip);
      }

      video.status = "done";
      video.spotCount = extraction.spots.length;
      trip.progress = `Finished "${data.title}" — found ${added} new spots.`;
      saveTrip(trip);
    } catch (err) {
      video.status = "error";
      video.error = err instanceof Error ? err.message : String(err);
      saveTrip(trip);
    }
  }

  const finished = getTrip(tripId);
  if (!finished) return;
  const allFailed =
    finished.videos.length > 0 && finished.videos.every((v) => v.status === "error");
  finished.status = allFailed ? "error" : "ready";
  finished.progress = allFailed
    ? "All videos failed to process."
    : `Done — ${finished.spots.length} spots on the map.`;
  saveTrip(finished);
}

export function makeTrip(id: string, urls: { id: string; url: string }[]): Trip {
  return {
    id,
    name: "Untitled trip",
    destination: null,
    createdAt: new Date().toISOString(),
    status: "processing",
    progress: "Starting…",
    videos: urls.map((u) => ({
      id: u.id,
      url: u.url,
      title: "",
      channelName: "",
      channelAvatar: "",
      thumbnail: "",
      status: "pending" as const,
    })),
    spots: [],
  };
}

function mergeThingsToKnow(spot: Spot, incoming: string[] | undefined) {
  if (!incoming?.length) return;
  const seen = new Set((spot.thingsToKnow ?? []).map(normalizeName));
  spot.thingsToKnow = [
    ...(spot.thingsToKnow ?? []),
    ...incoming.filter((t) => !seen.has(normalizeName(t))),
  ].slice(0, 8);
}

const backfilling = new Set<string>();

/**
 * One-time photo lookup for spots created before photos existed.
 * Fired from the trip GET route; saves after each spot so the polling UI
 * sees photos appear. `photo: null` marks "tried, nothing found" so we
 * never re-query Commons for the same spot.
 */
export async function backfillPhotos(tripId: string): Promise<void> {
  if (backfilling.has(tripId)) return;
  backfilling.add(tripId);
  try {
    const trip = getTrip(tripId);
    if (!trip) return;
    for (const spot of trip.spots) {
      if (spot.photo !== undefined) continue;
      try {
        spot.photo = await findSpotPhoto(spot.name, trip.destination?.name ?? null);
      } catch (err) {
        // Commons is unhappy (rate limit / network) — stop hammering, retry
        // the rest on the next page load
        console.warn("[photos] backfill paused:", err instanceof Error ? err.message : err);
        break;
      }
      saveTrip(trip);
    }
  } finally {
    backfilling.delete(tripId);
  }
}
