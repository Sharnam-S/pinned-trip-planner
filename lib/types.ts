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
  /** Set when this spot fell outside the trip's `bounds`. Kept, not dropped —
   *  a creator really did recommend it — but held back from the map fit, the
   *  planner's spot digest and the plan until the traveler opts it in. */
  outOfBounds?: boolean;
  /** Google Places id; null = Google lookup tried and missed; undefined = not tried yet. */
  placeId?: string | null;
}

/** `error` = this video is unreadable (no captions, unavailable) — replace it
 *  from the bench. `throttled` = YouTube pushed back on US after the retries in
 *  runner.ts ran out; the video is fine and a bench substitute would fail the
 *  same way, so the build pauses and offers a retry instead. */
export type VideoStatus =
  | "pending"
  | "processing"
  | "done"
  | "error"
  | "throttled";

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

/**
 * One base — somewhere you sleep for a stretch of the trip, and the days it
 * covers.
 *
 * `stay` above could only ever hold ONE place for a whole trip, which made the
 * most consequential question in multi-area travel unrepresentable: "Uluwatu 2
 * nights, Canggu 3, Ubud 4" had nowhere to live. And that decision drives
 * everything downstream — based in Ubud, an Uluwatu day is two hours each way,
 * so the basing choice silently decides which spots are even reachable.
 *
 * The real question is rarely "which hotel" but "how many bases": three moves
 * in ten days buys proximity and costs two half-days to packing and transfers.
 * That trade is what the agent is for.
 */
export interface ItineraryBase {
  /** The area as a traveler would say it — "Canggu", "Ubud", "the old town". */
  area: string;
  nights: number;
  /** 0-based day range this base covers, so the rail can say "Days 1-3". */
  fromDay?: number;
  toDay?: number;
  lat?: number;
  lng?: number;
  /** Why base here: what it puts within reach, what it saves. */
  why: string;
  /** True when the traveler told us they've already booked this one. Changes
   *  the section from a recommendation into a record of their plan. */
  booked?: boolean;
  /** Set ONLY when a booking they already hold looks genuinely costly — "two
   *  nights here, but one spot on your map and the rest 90 minutes north".
   *  Never advice on a booking that's merely different from our suggestion:
   *  they've paid, and second-guessing that is noise. */
  warning?: string;
  /** Creator-recommended places to sleep in this area — Spot ids of category
   *  "stay". The map already holds them; this is what makes the section a
   *  recommendation with receipts rather than a guess. */
  stayIds?: string[];
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
  /** Where to sleep, in trip order. Absent on plans written before bases
   *  existed, and on trips where the traveler never said. */
  bases?: ItineraryBase[];
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
  /** The destination's real extent, resolved once at discover time.
   *
   *  Without it the map has no idea what "this trip" means geographically, and
   *  it showed: a trip called "Tbilisi" carried Svaneti (9 hours away) and
   *  spanned nine times the city's longitude, so the map auto-fit to the
   *  outliers and a walkable old-town plan rendered as one unreadable cluster.
   *  Spots outside this box are kept but flagged (`Spot.outOfBounds`) rather
   *  than dropped — they're real recommendations, just not in this trip. */
  bounds?: TripBounds;
  /** Sub-regions the curator was asked to cover, for the coverage line (C3).
   *  Only set for region/country-scale destinations. */
  subAreas?: string[];
  /** Raw destination-level remarks harvested from every video, deduped and
   *  capped (MAX_TRIP_NOTES). Kept, not discarded after synthesis: the
   *  briefing is rewritten from these whenever more videos land. */
  notes?: BriefingNote[];
  /** The synthesized "before you go" briefing rendered above the pins. */
  briefing?: TripBriefing;
}

/** [[south, west], [north, east]] — the same shape Leaflet's fitBounds takes. */
export type TripBounds = [[number, number], [number, number]];

/* ---------------------------------------------------------------------------
 * The briefing: what creators said about the DESTINATION, not about a place.
 *
 * Every video we read is ~15 minutes long and maybe a third of it is a place
 * recommendation. The rest — "everything is cash below 20 lari", "Bolt, never a
 * taxi off the street", "the old town empties out by ten" — was extracted,
 * used once to write a pin's `thingsToKnow`, and otherwise thrown away. Twenty
 * videos of that is the orientation a traveler actually reads first, and we
 * were binning it.
 * ------------------------------------------------------------------------- */

/** Deliberately closed. An open `topic: string` produced a long tail of
 *  one-note headings ("Nightlife culture", "Tipping", "Tipping etiquette")
 *  that read as noise; a fixed set forces the model to merge instead. */
export type BriefingTopic =
  | "known-for"
  | "culture"
  | "lifestyle"
  | "when-to-go"
  | "getting-around"
  | "money"
  | "safety"
  | "food-drink"
  | "language"
  | "connectivity"
  | "health"
  | "practical";

/** One creator's remark about the destination, with its receipt. The quote and
 *  timestamp are not decoration: they're the only thing separating this from
 *  the model's own priors about a country. */
export interface BriefingNote {
  topic: BriefingTopic;
  /** One standalone, actionable sentence. */
  point: string;
  /** What the creator actually said, near-verbatim. */
  quote: string;
  videoId: string;
  timestampSec: number;
}

/** Which videos a section was written from. Only the ids and a timestamp to
 *  jump to — titles, channels and avatars are resolved from `Trip.videos` at
 *  render time rather than copied per source. */
export interface BriefingSource {
  videoId: string;
  timestampSec: number;
}

export interface BriefingSection {
  topic: BriefingTopic;
  /** 2-5 standalone bullets merged across creators, specifics kept, padding
   *  dropped. Bullets rather than prose because this is skimmed once, before
   *  planning starts — a paragraph makes the traveler read all of it to find
   *  the one line that changes their trip. */
  points: string[];
  sources: BriefingSource[];
}

/** The synthesized briefing stored on the trip. */
export interface TripBriefing {
  /** Bump when the topic set or the synthesis contract changes. */
  version: number;
  updatedAt: string;
  /** How many notes it was written from — if the trip has more now (a video
   *  was added), the briefing is stale and gets rewritten. */
  fromNotes: number;
  sections: BriefingSection[];
}
