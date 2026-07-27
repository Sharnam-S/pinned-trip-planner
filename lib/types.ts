export type SpotCategory =
  | "food"
  | "nightlife"
  | "nature"
  | "beach"
  | "viewpoint"
  | "landmark"
  | "museum"
  | "activity"
  | "wellness"
  | "market"
  | "shopping"
  | "stay"
  | "town"
  | "other";

export interface Mention {
  videoId: string;
  videoTitle: string;
  channelName: string;
  channelAvatar: string;
  timestampSec: number;
  quote: string;
}

export interface SpotPhotoRef {
  url: string;
  source: "wikimedia" | "google";
}

export interface Spot {
  id: string;
  name: string;
  category: SpotCategory;
  description: string;
  lat: number;
  lng: number;
  geocodeSource: "google" | "nominatim" | "llm";
  mentions: Mention[];
  /** Practical tips/warnings creators mentioned (pickpockets, timings, tickets…). */
  thingsToKnow?: string[];
  /** Primary photo; null = lookup tried and missed; undefined = not looked up yet. */
  photo?: SpotPhotoRef | null;
  /** Photo carousel (Google Places, up to 5). [] = tried, none; undefined = not tried. */
  photos?: SpotPhotoRef[];
  /** How many more Google photos this spot has beyond the resolved ones. The
   *  carousel needs the COUNT, not the names: /api/photo fetches by placeId +
   *  index, so the names were never dereferenced — and at ~1.9KB per spot they
   *  were half the weight of a stored trip. */
  morePhotos?: number;
  /** Legacy of the above: photo resource names, still read for spots resolved
   *  before /api/photo existed (no placeId, so they must be resolved by name
   *  through /api/photos on first swipe). Never written for new spots. */
  morePhotoNames?: string[];
  /** Google Places id; null = Google lookup tried and missed; undefined = not tried yet. */
  placeId?: string | null;
}

export type VideoStatus = "pending" | "processing" | "done" | "error";

export interface TripVideo {
  id: string; // YouTube video id
  url: string;
  title: string;
  channelName: string;
  channelAvatar: string;
  thumbnail: string;
  status: VideoStatus;
  error?: string;
  spotCount?: number;
}

export interface Destination {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
}

export type TripStatus = "processing" | "ready" | "error";

/** Inputs for search-mode trips: we find the videos on the user's behalf. */
/** Who the trip is for. Shapes pace, food choices, and what the planner
 *  suggests — a solo surfer and a family of four don't want the same day. */
export type TripParty = "solo" | "couple" | "friends" | "family" | "group";

export interface TripQuery {
  /** Raw user input, e.g. "tbilisi" */
  destination: string;
  /** What the planner resolved it to, e.g. "Tbilisi, Georgia" */
  resolvedDestination?: string;
  /** ISO dates (yyyy-mm-dd); optional — season-neutral queries when absent */
  startDate?: string;
  endDate?: string;
  /** Free text, e.g. "skiing, wine" */
  interests?: string;
  party?: TripParty;
}

export type ItinerarySlot = "morning" | "afternoon" | "evening";

export interface ItineraryStop {
  /** References Spot.id — stops render in array order (visit order). */
  spotId: string;
  slot?: ItinerarySlot;
  /** Planned arrival, 24h "HH:MM". */
  time?: string;
  /** How long to spend here, in minutes. */
  durationMin?: number;
  /** Why the agent picked this spot for this day/slot — shown on the spot
   *  card so the user can audit the plan. */
  why?: string;
  /** Agent tip for this stop ("go before 9am to beat the queue"). */
  note?: string;
}

export interface ItineraryDay {
  label: string; // "Day 1"
  date?: string; // yyyy-mm-dd
  theme?: string; // "Old town + street food"
  /** Why the day is grouped/ordered this way — shown in the map's day brief. */
  rationale?: string;
  stops: ItineraryStop[];
}

export interface ItineraryStay {
  name: string;
  lat?: number;
  lng?: number;
  note?: string;
}

export type ItineraryPace = "packed" | "balanced" | "relaxed";

/** The planner agent's artifact: a day-by-day plan over the trip's spots.
 *  Edited via the update_itinerary tool; rendered by the map and cards.
 *
 *  A trip holds several of these side by side — "east coast only" vs "east,
 *  south, then the airport" — so the traveler can compare shapes before
 *  committing. See `Trip.itineraries`. */
export interface Itinerary {
  /** Stable id for this option, minted by the agent (a slug like
   *  "east-coast") or by the UI. Optional only for plans written before
   *  options existed; `normalizePlans` fills it in on read. */
  id?: string;
  /** Short, distinct name naming the tradeoff ("East coast only"). Same
   *  back-compat story as `id`. */
  title?: string;
  days: ItineraryDay[];
  stay?: ItineraryStay;
  pace?: ItineraryPace;
  budget?: string;
  updatedAt: string;
}

export interface Trip {
  id: string;
  /** Account that owns this trip ("google:<sub>"). Absent on pre-account
   *  trips, samples, and copies published to the community library. */
  ownerId?: string;
  name: string;
  /** A title the user typed over the top of `name` ("First 3 days in Sri
   *  Lanka"). Purely a label: `name` stays the resolved destination, so the
   *  map, the flag and the planner's context are untouched by a rename. */
  label?: string;
  destination: Destination | null;
  createdAt: string;
  status: TripStatus;
  progress: string;
  videos: TripVideo[];
  spots: Spot[];
  /** Transient (set by the API, never saved): a Google data upgrade is running,
   *  keep polling. */
  upgrading?: boolean;
  /** Search-mode inputs (absent on paste-your-own-links trips). */
  query?: TripQuery;
  /** LEGACY: the single day-by-day plan, before a trip could hold several
   *  options. Still written by nothing, still read by `normalizePlans`, which
   *  folds it into `itineraries` the first time anything touches the trip. */
  itinerary?: Itinerary;
  /** The planner's parallel plan options, in creation order (local trips only
   *  — sample trips keep a visitor's plans in a localStorage overlay instead).
   *  One trip, several candidate shapes; the traveler picks the one to
   *  finalize. Capped at MAX_PLANS. */
  itineraries?: Itinerary[];
  /** Ranked substitute video ids, used when a picked video has no captions. */
  bench?: string[];
}
