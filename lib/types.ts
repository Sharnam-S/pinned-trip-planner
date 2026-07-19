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
  /** Google photo resource names not yet resolved to URLs — fetched lazily on
   *  first carousel swipe so unswiped cards never bill the Photos API. */
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
 *  Edited via the update_itinerary tool; rendered by the map and cards. */
export interface Itinerary {
  days: ItineraryDay[];
  stay?: ItineraryStay;
  pace?: ItineraryPace;
  budget?: string;
  updatedAt: string;
}

export interface Trip {
  id: string;
  name: string;
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
  /** Day-by-day plan built by the planner agent (local trips only — sample
   *  trips keep a visitor's plan in a localStorage overlay instead). */
  itinerary?: Itinerary;
  /** Ranked substitute video ids, used when a picked video has no captions. */
  bench?: string[];
}
