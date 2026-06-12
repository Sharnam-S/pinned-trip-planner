import crypto from "crypto";
import { getTrip, saveTrip } from "./store";
import { fetchVideoData } from "./youtube";
import { extractSpots } from "./extract";
import { geocode } from "./geocode";
import { findSpotPhoto } from "./photos";
import {
  googleFindPlace,
  googlePhotoUrl,
  googlePlacePhotoNames,
  isGoogleEnabled,
} from "./google";
import { curateVideos, gatherCandidates, planSearchQueries } from "./discover";
import { Mention, Spot, SpotPhotoRef, Trip, TripQuery, TripVideo } from "./types";

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
        // Disambiguate with THIS video's destination, not the trip-level one
        // (which is whatever the first video covered). A multi-region trip —
        // e.g. south-coast + Arugam Bay videos — would otherwise tag every
        // east-coast spot with "Weligama…", making Google return south-coast
        // places that fail the distance check and strand the pin on the LLM's
        // rough guess.
        const resolved = await resolveSpotData(
          raw.name,
          raw.geocode_query,
          raw.lat,
          raw.lng,
          extraction.destination?.name ?? trip.destination?.name ?? null
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
          photo: resolved.photo,
          photos: resolved.photos,
          morePhotoNames: resolved.morePhotoNames,
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

export function makeSearchTrip(id: string, query: TripQuery): Trip {
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

function pendingVideo(id: string, title = "", channelName = ""): TripVideo {
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

const PICK_COUNT = 5;

/**
 * Search-mode trips: find the videos on the user's behalf, then run the
 * normal extraction pipeline. Videos that turn out to have no captions are
 * swapped for the next-best candidate from the bench instead of erroring.
 */
export async function discoverAndProcess(tripId: string): Promise<void> {
  let trip = getTrip(tripId);
  if (!trip?.query) return;

  try {
    const plan = await planSearchQueries(trip.query);
    trip = getTrip(tripId)!;
    trip.query!.resolvedDestination = plan.resolvedDestination;
    trip.name = plan.resolvedDestination;
    trip.progress = `Searching YouTube: ${plan.queries.map((q) => `“${q}”`).join(", ")}`;
    saveTrip(trip);

    const candidates = await gatherCandidates(plan.queries);
    if (candidates.length === 0) {
      throw new Error(
        `Couldn't find travel videos for "${plan.resolvedDestination}". Try a different destination spelling.`
      );
    }
    trip = getTrip(tripId)!;
    trip.progress = `Found ${candidates.length} candidate videos — picking the best ${PICK_COUNT}…`;
    saveTrip(trip);

    const ranked = await curateVideos(candidates, trip.query!, plan.resolvedDestination);
    if (ranked.length === 0) {
      throw new Error(
        `None of the videos found looked like real travel guides for "${plan.resolvedDestination}".`
      );
    }
    const byId = new Map(candidates.map((c) => [c.id, c]));
    trip = getTrip(tripId)!;
    trip.videos = ranked.slice(0, PICK_COUNT).map((id) => {
      const c = byId.get(id);
      return pendingVideo(id, c?.title, c?.channelName);
    });
    trip.bench = ranked.slice(PICK_COUNT);
    trip.progress = `Picked ${trip.videos.length} videos from ${trip.videos.length} creators — reading transcripts…`;
    saveTrip(trip);
  } catch (err) {
    const t = getTrip(tripId);
    if (!t) return;
    t.status = "error";
    t.progress = err instanceof Error ? err.message : String(err);
    saveTrip(t);
    return;
  }

  // Process, substituting caption-less picks from the bench (bounded rounds)
  for (let round = 0; round < 4; round++) {
    await processTrip(tripId);
    const t = getTrip(tripId);
    if (!t) return;
    const errored = t.videos.filter((v) => v.status === "error");
    if (errored.length === 0 || !t.bench || t.bench.length === 0) break;

    const subs = t.bench.splice(0, errored.length);
    t.videos = t.videos.filter((v) => v.status !== "error");
    t.videos.push(...subs.map((id) => pendingVideo(id)));
    t.status = "processing";
    t.progress = `${errored.length} video${errored.length === 1 ? " has" : "s have"} no captions — swapping in replacement${subs.length === 1 ? "" : "s"}…`;
    saveTrip(t);
  }
}

function mergeThingsToKnow(spot: Spot, incoming: string[] | undefined) {
  if (!incoming?.length) return;
  const seen = new Set((spot.thingsToKnow ?? []).map(normalizeName));
  spot.thingsToKnow = [
    ...(spot.thingsToKnow ?? []),
    ...incoming.filter((t) => !seen.has(normalizeName(t))),
  ].slice(0, 8);
}

/**
 * Coordinates + photo for one spot. Google Places (precise POIs, real place
 * photos) when a key is configured; Nominatim + Wikimedia Commons otherwise.
 * A Google miss still falls back to the free path.
 */
/** Up to 5 carousel photos, best first. */
const MAX_PHOTOS = 5;

async function resolvePhotoSet(photoNames: string[]): Promise<SpotPhotoRef[]> {
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
  morePhotoNames: string[] | undefined;
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
        // first carousel swipe (see resolveMorePhotos).
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
          morePhotoNames: names.slice(1),
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
    morePhotoNames: undefined,
  };
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

/** True when this trip has spots a configured Google key could improve. */
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

const resolvingPhotos = new Set<string>();

/**
 * Lazily resolves a spot's remaining carousel photos (first swipe on the
 * tile). Idempotent: returns the already-complete list when there's nothing
 * pending, and a per-spot in-flight guard stops double-billing on rapid
 * clicks. Returns null when the trip/spot doesn't exist.
 */
export async function resolveMorePhotos(
  tripId: string,
  spotId: string
): Promise<string[] | null> {
  const key = `${tripId}:${spotId}`;
  if (resolvingPhotos.has(key)) {
    // someone's already on it — report what's resolved so far
    const t = getTrip(tripId);
    const s = t?.spots.find((x) => x.id === spotId);
    return s ? (s.photos ?? []).map((p) => p.url) : null;
  }
  resolvingPhotos.add(key);
  try {
    const trip = getTrip(tripId);
    const spot = trip?.spots.find((s) => s.id === spotId);
    if (!trip || !spot) return null;
    if (spot.morePhotoNames?.length) {
      const extra = await resolvePhotoSet(spot.morePhotoNames);
      const seen = new Set((spot.photos ?? []).map((p) => p.url));
      spot.photos = [...(spot.photos ?? []), ...extra.filter((p) => !seen.has(p.url))];
      spot.morePhotoNames = undefined;
      saveTrip(trip);
    }
    return (spot.photos ?? []).map((p) => p.url);
  } finally {
    resolvingPhotos.delete(key);
  }
}

const upgrading = new Set<string>();

/**
 * One-time Google upgrade for trips created before the key existed (or before
 * this feature): re-resolves each spot's coordinates via Places Text Search
 * and swaps in a real place photo. Runs in the background off the trip GET
 * route, saving after every spot so the polling UI shows pins sliding to
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
            spot.morePhotoNames = names.slice(1);
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
          spot.morePhotoNames = names.slice(1);
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
