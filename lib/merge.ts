/**
 * Pure trip-mutation helpers shared by the browser runner (localStorage trips)
 * and the server pipeline. No fs, no API clients — safe in both bundles.
 */
import { mergeNotes } from "./briefing";
import {
  BriefingNote,
  Destination,
  Mention,
  Spot,
  Trip,
  TripQuery,
  TripVideo,
} from "./types";

export function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------------------------------------------------------------
 * Finding the spot a video is talking about.
 *
 * This used to be exact equality on `normalizeName`, and one place on Skye came
 * out as THREE pins: "The Quiraing" (3 creators), "Quiraing", and "Quiraing
 * Mountains (Trotternish Ridge)". Three strings, three spots, one mountain.
 *
 * The defence that was supposed to prevent it is dead code. `extractSpots`
 * takes `knownSpotNames` and tells the model "reuse the EXACT same name string
 * so it can be merged" — but `processVideoRaw` calls it with an EMPTY array,
 * and always has to: extractions are cached cross-trip, so they can't depend on
 * what any one trip has already found. The cache made per-trip name consistency
 * impossible, and nothing downstream was strengthened to compensate.
 *
 * So matching has to be post-hoc, and it's layered by how much each signal can
 * be trusted:
 *
 *   1. Google place id — authoritative. Two spots Google resolved to the same
 *      id ARE the same place, whatever the creators called them.
 *   2. Exact normalized name — the old rule, kept.
 *   3. Article/parenthetical-stripped name — "The Quiraing" == "Quiraing".
 *      Still exact, so still safe with no distance check.
 *   4. One name's significant words contained in the other's, SAME CATEGORY,
 *      and geographically close. This is the loose one, so it carries all
 *      three guards: "Sairee Beach" and "Sairee Beach Bar" share words but
 *      differ in category, and two "Blue Lagoon"s in different countries are
 *      far apart.
 *
 * The asymmetry that sets the tuning: under-merging shows an ugly duplicate
 * pin, which is visible and annoying. OVER-merging silently destroys a real
 * recommendation, which nobody ever notices. When in doubt, don't merge.
 * ------------------------------------------------------------------------- */

/** Words that carry no identity — dropped before comparing names. */
const NAME_STOPWORDS = new Set([
  "the", "a", "an", "of", "at", "in", "on", "and", "de", "la", "le",
]);

/** Rule 4's distance ceiling. Generous because it's guarded by category and
 *  word containment, and because a big natural feature legitimately has its
 *  coordinates guessed kilometres apart by two different videos. */
const DUPLICATE_MERGE_KM = 3;

/** Rule 3's ceiling. Wider, because an identical name is much stronger
 *  evidence — but not unbounded: a trip can pick up a far-away namesake (an
 *  East Coast Sri Lanka trip once collected a spot called "Maldives"), and
 *  collapsing two real places into one is the failure nobody ever sees. */
const SAME_NAME_MERGE_KM = 50;

/** "The Quiraing" and "Quiraing (Trotternish)" both reduce to "quiraing". */
function bareName(name: string): string {
  return normalizeName(name.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((w) => w && !NAME_STOPWORDS.has(w))
    .join(" ");
}

/** Every significant word of the shorter name appears in the longer one. */
function nameContained(a: string, b: string): boolean {
  const wa = bareName(a).split(" ").filter(Boolean);
  const wb = bareName(b).split(" ").filter(Boolean);
  if (wa.length === 0 || wb.length === 0) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

/** Rough great-circle km. Local copy so merge.ts stays dependency-free. */
function kmApart(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

/** The spot in `spots` that `candidate` is another name for, if any. */
export function findDuplicate(
  spots: Spot[],
  candidate: { name: string; category?: string; lat: number; lng: number; placeId?: string | null }
): Spot | undefined {
  // 1. Google's own answer, and it outranks everything.
  if (typeof candidate.placeId === "string" && candidate.placeId) {
    const byPlace = spots.find((s) => s.placeId === candidate.placeId);
    if (byPlace) return byPlace;
  }
  // 2 + 3. Exact, then article/parenthetical-stripped.
  const exact = spots.find(
    (s) => normalizeName(s.name) === normalizeName(candidate.name)
  );
  if (exact) return exact;
  const bare = bareName(candidate.name);
  if (bare) {
    const stripped = spots.find(
      (s) => bareName(s.name) === bare && kmApart(s, candidate) <= SAME_NAME_MERGE_KM
    );
    if (stripped) return stripped;
  }
  // 4. The loose rule, fully guarded.
  return spots.find((s) => {
    if (candidate.category && s.category !== candidate.category) return false;
    // Two DIFFERENT Google ids is Google telling us these are different
    // places. A word-overlap heuristic doesn't get to overrule that.
    if (
      typeof s.placeId === "string" &&
      typeof candidate.placeId === "string" &&
      s.placeId !== candidate.placeId
    ) {
      return false;
    }
    if (!nameContained(s.name, candidate.name)) return false;
    return kmApart(s, candidate) <= DUPLICATE_MERGE_KM;
  });
}

/**
 * Near-duplicates that survived the merge — the same failure the traveler sees
 * as three pins on one mountain.
 *
 * Deliberately LOOSER than `findDuplicate`: this reports, it doesn't merge, so
 * it can afford false positives that the merge itself must not. It is the only
 * way to know whether the matching rules are actually holding on real trips,
 * because the bug is invisible from inside any single video — each extraction
 * is cached trip-independently and never sees what the others called a place.
 */
export function findNearDuplicates(spots: Spot[]): [string, string][] {
  const pairs: [string, string][] = [];
  const visible = spots.filter((s) => !s.outOfBounds);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i];
      const b = visible[j];
      if (!nameContained(a.name, b.name)) continue;
      if (kmApart(a, b) > DUPLICATE_MERGE_KM) continue;
      pairs.push([a.name, b.name]);
      if (pairs.length >= 10) return pairs;
    }
  }
  return pairs;
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
  /** Destination-level remarks from this video, for the trip briefing. Unlike
   *  spots these are never "already known" — they're deduped at the trip level
   *  by `mergeNotes`, which is where the cross-video overlap actually is. */
  notes: BriefingNote[];
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
  /** Absent on entries cached before briefings existed — see
   *  VIDEO_CACHE_VERSION, which is bumped so that never actually happens. */
  notes?: BriefingNote[];
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
    notes: cached.notes ?? [],
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
    const existing = findDuplicate(trip.spots, spot);
    if (existing) {
      // server couldn't know another video in this batch already added it
      mergeMention(existing, spot.mentions[0], spot.thingsToKnow);
      continue;
    }
    // A creator's video about "Tbilisi" will happily spend five minutes on
    // Svaneti, nine hours away — and an East Coast Sri Lanka trip picked up a
    // spot called "Maldives". Keep them (they're real recommendations) but flag
    // them, so the map fit, the planner's digest and the plan all ignore them
    // until the traveler says otherwise.
    if (isOutOfBounds(trip, spot)) spot.outOfBounds = true;
    trip.spots.push(spot);
    added++;
  }
  for (const k of result.knownMentions) {
    // Only a name here — knownMentions carry no coordinates — so this reaches
    // rules 1-3 and stops short of the geographic one.
    const existing =
      trip.spots.find((s) => normalizeName(s.name) === normalizeName(k.name)) ??
      trip.spots.find((s) => bareName(s.name) === bareName(k.name));
    if (existing) mergeMention(existing, k.mention, k.thingsToKnow);
  }
  mergeNotes(trip, result.notes);
  return added;
}

/** How far through its videos a trip is.
 *
 *  `running` and `settled` are deliberately NOT complements. "Is the build
 *  still reading?" and "is this map final?" are different questions with
 *  different costs of being wrong:
 *
 *  - `running` gates PLANNING. A build that has stopped — even one that gave up
 *    rate-limited with videos still queued — leaves a map that is as good as it
 *    will get without the traveler doing something, and they must be able to
 *    plan on it. Blocking on "any video unread" would strand them for good.
 *  - `settled` gates the COVERAGE WARNING, which claims the map is missing
 *    regions. That claim is only safe once nothing more is coming at all. */
export function buildProgress(trip: Trip): {
  videosRead: number;
  videosTotal: number;
  running: boolean;
  settled: boolean;
} {
  const videosTotal = trip.videos.length;
  const videosRead = trip.videos.filter((v) => v.status === "done").length;
  const running = trip.status === "processing";
  return {
    videosRead,
    videosTotal,
    running,
    settled:
      !running &&
      videosTotal > 0 &&
      trip.videos.every((v) => v.status === "done" || v.status === "error"),
  };
}

/** Outside the destination's own extent? Unknown bounds means "keep it" — a
 *  geocoder miss must never quietly hide a traveler's spots. */
export function isOutOfBounds(trip: Trip, spot: { lat: number; lng: number }): boolean {
  const b = trip.bounds;
  if (!b) return false;
  const [[south, west], [north, east]] = b;
  return spot.lat < south || spot.lat > north || spot.lng < west || spot.lng > east;
}

function mergeMention(spot: Spot, mention: Mention | undefined, tips?: string[]) {
  if (mention && !spot.mentions.some((m) => m.videoId === mention.videoId)) {
    spot.mentions.push(mention);
  }
  mergeThingsToKnow(spot, tips);
}
