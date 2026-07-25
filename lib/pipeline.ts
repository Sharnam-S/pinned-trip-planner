import crypto from "crypto";
import { getTrip, saveTrip } from "./store";
import { fetchVideoData } from "./youtube";
import { extractSpots } from "./extract";
import { TripTag } from "./llm";
import { geocode } from "./geocode";
import { findSpotPhoto } from "./photos";
import {
  googleFindPlace,
  googlePhotoUrl,
  googlePlacePhotoNames,
  isGoogleEnabled,
} from "./google";
import {
  CachedVideo,
  mergeThingsToKnow,
  normalizeName,
  partitionCachedVideo,
  VideoResult,
} from "./merge";
import { getCachedVideo, putCachedVideo, VIDEO_CACHE_VERSION } from "./videoCache";
import { Mention, Spot, SpotPhotoRef, Trip } from "./types";

/**
 * Reads one video and returns everything the client needs to fold it into a
 * trip: video metadata, the video's own destination, fully-resolved new spots
 * (coords, placeId, cover photo), and mentions of already-known spots.
 *
 * Cross-trip cached by YouTube id: the expensive work (transcript fetch, Claude
 * extraction, Google lookups) is trip-independent, so the first trip to include
 * a video pays for it and every later trip — yours or a friend's — reuses the
 * stored result and just re-partitions it against its own known spots.
 *
 * Stateless per trip on purpose — trips live in the visitor's localStorage, so
 * the browser orchestrates videos one call at a time and saves between calls.
 */
export async function processVideo(
  videoId: string,
  knownSpotNames: string[],
  trip?: TripTag
): Promise<VideoResult> {
  const cached = await getCachedVideo(videoId);
  if (cached) return partitionCachedVideo(cached, knownSpotNames);

  const fresh = await processVideoRaw(videoId, trip);
  // Best-effort: a cache write must never fail the video — worst case the next
  // trip re-processes it.
  await putCachedVideo(fresh).catch((err) =>
    console.warn("[videoCache] write failed:", err instanceof Error ? err.message : err)
  );
  return partitionCachedVideo(fresh, knownSpotNames);
}

/**
 * Trip-independent processing of one video: fetch it and fully resolve EVERY
 * spot it discusses (no knownSpotNames — that partitioning happens per trip in
 * `partitionCachedVideo`). This is what we cache and share across trips.
 */
export async function processVideoRaw(
  videoId: string,
  trip?: TripTag
): Promise<CachedVideo> {
  const data = await fetchVideoData(videoId);
  const extraction = await extractSpots(data, [], undefined, trip);

  const byName = new Map<string, Spot>();
  const spots: Spot[] = [];

  for (const raw of extraction.spots) {
    const mention: Mention = {
      videoId: data.id,
      videoTitle: data.title,
      channelName: data.channelName,
      channelAvatar: data.channelAvatar,
      timestampSec: Math.max(0, Math.floor(raw.timestamp_sec)),
      quote: raw.quote,
    };

    // Same place mentioned twice in one video — keep one spot (one mention per
    // video), just fold in any extra tips.
    const existing = byName.get(normalizeName(raw.name));
    if (existing) {
      mergeThingsToKnow(existing, raw.things_to_know);
      continue;
    }

    // Disambiguate with THIS video's destination, not a trip-level one —
    // a multi-region trip (e.g. south-coast + Arugam Bay videos) would
    // otherwise tag every spot with the first video's region, making Google
    // return far-away places that fail the distance check and strand the pin
    // on the LLM's rough guess.
    const resolved = await resolveSpotData(
      raw.name,
      raw.geocode_query,
      raw.lat,
      raw.lng,
      extraction.destination?.name ?? null
    );

    const spot: Spot = {
      id: crypto.randomUUID(),
      name: raw.name,
      category: raw.category,
      description: raw.description,
      lat: resolved.lat,
      lng: resolved.lng,
      geocodeSource: resolved.geocodeSource,
      placeId: resolved.placeId,
      mentions: [mention],
      thingsToKnow: (raw.things_to_know ?? []).slice(0, 6),
      photo: resolved.photo ?? null,
      photos: resolved.photos,
      morePhotos: resolved.morePhotos,
    };
    byName.set(normalizeName(raw.name), spot);
    spots.push(spot);
  }

  return {
    version: VIDEO_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    video: {
      id: data.id,
      url: `https://www.youtube.com/watch?v=${data.id}`,
      title: data.title,
      channelName: data.channelName,
      channelAvatar: data.channelAvatar,
      thumbnail: data.thumbnail,
      spotCount: extraction.spots.length,
    },
    destination: extraction.destination,
    spots,
  };
}

/**
 * Coordinates + photo for one spot. Google Places (precise POIs, real place
 * photos) when a key is configured; Nominatim + Wikimedia Commons otherwise.
 * A Google miss still falls back to the free path.
 */
/** Up to 5 carousel photos, best first. */
const MAX_PHOTOS = 5;

export async function resolvePhotoSet(photoNames: string[]): Promise<SpotPhotoRef[]> {
  // One media call per photo is unavoidable (no batch endpoint), but they can
  // all fly at once. Billed once here; the stored URLs render free forever.
  const urls = await Promise.all(
    photoNames
      .slice(0, MAX_PHOTOS)
      .map((name) => googlePhotoUrl(name).catch(() => null))
  );
  return urls
    .filter((url): url is string => Boolean(url))
    .map((url) => ({ url, source: "google" as const }));
}

async function resolveSpotData(
  name: string,
  geocodeQuery: string,
  llmLat: number,
  llmLng: number,
  destinationName: string | null
): Promise<{
  lat: number;
  lng: number;
  geocodeSource: Spot["geocodeSource"];
  placeId: string | null | undefined;
  photo: SpotPhotoRef | null | undefined;
  photos: SpotPhotoRef[] | undefined;
  morePhotos: number | undefined;
}> {
  if (isGoogleEnabled()) {
    try {
      const place = await googleFindPlace(
        destinationName ? `${name}, ${destinationName}` : name,
        llmLat,
        llmLng
      );
      if (place) {
        const names = place.photoNames.slice(0, MAX_PHOTOS);
        // Only the cover photo is billed now; the rest resolve lazily on the
        // first carousel swipe (see /api/photos).
        const photos = await resolvePhotoSet(names.slice(0, 1));
        const photo =
          photos[0] ??
          (await findSpotPhoto(name, destinationName).catch(() => undefined));
        return {
          lat: place.lat,
          lng: place.lng,
          geocodeSource: "google",
          placeId: place.id,
          photo,
          photos,
          morePhotos: Math.max(0, names.length - 1),
        };
      }
    } catch (err) {
      console.warn("[google] lookup failed:", err instanceof Error ? err.message : err);
    }
  }
  const coords = await geocode(geocodeQuery, llmLat, llmLng);
  return {
    lat: coords.lat,
    lng: coords.lng,
    geocodeSource: coords.source,
    placeId: isGoogleEnabled() ? null : undefined,
    photo: await findSpotPhoto(name, destinationName).catch(() => undefined),
    photos: undefined,
    morePhotos: undefined,
  };
}

const backfilling = new Set<string>();

/**
 * One-time photo lookup for sample trips created before photos existed.
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

/** True when this sample trip has spots a configured Google key could improve. */
export function needsGoogleUpgrade(trip: Trip): boolean {
  return (
    isGoogleEnabled() &&
    trip.spots.some(
      (s) =>
        s.placeId === undefined ||
        // resolved before carousels existed — photo set still to fetch
        (typeof s.placeId === "string" && s.photos === undefined)
    )
  );
}

const upgrading = new Set<string>();

/**
 * One-time Google upgrade for sample trips created before the key existed (or
 * before this feature): re-resolves each spot's coordinates via Places Text
 * Search and swaps in a real place photo. Runs in the background off the trip
 * GET route, saving after every spot so the polling UI shows pins sliding to
 * their corrected positions. `placeId: null` marks "Google tried, no match"
 * so a spot is never re-queried.
 */
export async function upgradeTripWithGoogle(tripId: string): Promise<void> {
  if (!isGoogleEnabled() || upgrading.has(tripId)) return;
  upgrading.add(tripId);
  try {
    const trip = getTrip(tripId);
    if (!trip) return;
    for (const spot of trip.spots) {
      try {
        if (spot.placeId === undefined) {
          // Search trips: trip.destination is just the first video's region —
          // use the broader resolved destination so spots from other regions
          // aren't dragged toward it.
          const destName = trip.query?.resolvedDestination ?? trip.destination?.name;
          const place = await googleFindPlace(
            destName ? `${spot.name}, ${destName}` : spot.name,
            spot.lat,
            spot.lng
          );
          if (place) {
            const names = place.photoNames.slice(0, MAX_PHOTOS);
            spot.placeId = place.id;
            spot.lat = place.lat;
            spot.lng = place.lng;
            spot.geocodeSource = "google";
            spot.photos = await resolvePhotoSet(names.slice(0, 1));
            spot.morePhotos = Math.max(0, names.length - 1);
            if (spot.photos[0]) spot.photo = spot.photos[0];
          } else {
            spot.placeId = null; // keep the existing coords + photo
          }
        } else if (typeof spot.placeId === "string" && spot.photos === undefined) {
          // resolved before carousels existed — cover photo now, rest lazily
          const names = (await googlePlacePhotoNames(spot.placeId).catch(() => [])).slice(
            0,
            MAX_PHOTOS
          );
          spot.photos = await resolvePhotoSet(names.slice(0, 1));
          spot.morePhotos = Math.max(0, names.length - 1);
          if (spot.photos[0]) spot.photo = spot.photos[0];
        } else {
          continue;
        }
      } catch (err) {
        // quota / network — stop here, the rest upgrades on a later visit
        console.warn("[google] upgrade paused:", err instanceof Error ? err.message : err);
        break;
      }
      saveTrip(trip);
    }
  } finally {
    upgrading.delete(tripId);
  }
}
