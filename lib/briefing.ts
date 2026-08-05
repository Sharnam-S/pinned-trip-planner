/**
 * The destination briefing: topic table, note merging, staleness.
 *
 * Pure and dependency-free like `merge.ts` — the browser runner, the trip page
 * and the server route all import it. The model call that turns notes into
 * sections lives in `briefingSynth.ts`, which pulls in the Anthropic SDK and
 * must never reach the client bundle.
 */
import { BriefingNote, BriefingTopic, Trip, TripBriefing } from "./types";

/** Bump when the topic set or the synthesis contract changes, so stored
 *  briefings are rewritten instead of rendering against a stale shape.
 *  1 (2026-08-03): first version.
 *  2 (2026-08-05): sections are bullets (`points`), not a prose `summary`. */
export const BRIEFING_VERSION = 2;

/** Render order, top to bottom. Orientation before logistics: a traveler wants
 *  to know what the place IS before they want to know how to pay for it. */
export const BRIEFING_TOPICS: {
  id: BriefingTopic;
  label: string;
  emoji: string;
  /** Shown to the model as the topic's remit. Doubles as the tooltip. */
  remit: string;
}[] = [
  {
    id: "known-for",
    label: "What it's known for",
    emoji: "✨",
    remit:
      "What this destination is actually famous for and what kind of trip it suits — the character of the place, who tends to love it and who doesn't.",
  },
  {
    id: "culture",
    label: "Culture & etiquette",
    emoji: "🧭",
    remit:
      "Customs, manners and expectations: how people greet, dress codes at religious sites, what's rude, bargaining norms, photography etiquette.",
  },
  {
    id: "lifestyle",
    label: "Everyday rhythm",
    emoji: "☕",
    remit:
      "The pace and shape of a day here: when things open and close, siestas, late dinners, weekend closures, how early or late the place comes alive.",
  },
  {
    id: "when-to-go",
    label: "Weather & when to go",
    emoji: "🌦️",
    remit:
      "Seasons, monsoon and shoulder months, temperatures, crowds, festivals, and anything that shuts for part of the year.",
  },
  {
    id: "getting-around",
    label: "Getting around",
    emoji: "🚕",
    remit:
      "Transport between and within places: which ride app people use, trains and buses, scooter or car rental, driving conditions, typical fares and journey times.",
  },
  {
    id: "money",
    label: "Money & paying",
    emoji: "💳",
    remit:
      "Cash versus card, which cards are accepted where, ATMs, currency and exchange, tipping norms, haggling, and what things roughly cost.",
  },
  {
    id: "safety",
    label: "Safety",
    emoji: "🛟",
    remit:
      "Scams, pickpocketing, areas to avoid after dark, stray dogs, traffic, water and surf hazards. Say explicitly when advice differs for solo travelers (and for women travelling alone) versus groups — creators often draw that line and it must not be flattened away.",
  },
  {
    id: "food-drink",
    label: "Eating & drinking",
    emoji: "🍽️",
    remit:
      "Food culture rather than restaurants: what to order, meal times, street-food safety, vegetarian and allergy realities, alcohol rules, coffee and tea customs.",
  },
  {
    id: "language",
    label: "Language",
    emoji: "💬",
    remit:
      "How far English gets you, which phrases earn goodwill, script and signage, whether translation apps are needed.",
  },
  {
    id: "connectivity",
    label: "Staying connected",
    emoji: "📶",
    remit: "SIMs and eSIMs, coverage and dead zones, wifi quality, useful local apps.",
  },
  {
    id: "health",
    label: "Health & water",
    emoji: "💊",
    remit:
      "Tap water, stomach trouble, mosquitoes, altitude, sun, pharmacies, vaccinations and insurance — only what creators actually raised.",
  },
  {
    id: "practical",
    label: "Practical bits",
    emoji: "🧳",
    remit:
      "Visas and arrival, plug types, what to pack, luggage, laundry, toilets — the leftovers that still change a trip.",
  },
];

/** The same ids as a tuple, for `z.enum` in the extraction and synthesis
 *  schemas. Derived, not re-typed, so a new topic can never be offered by one
 *  schema and rejected by the other. */
export const BRIEFING_TOPIC_IDS = BRIEFING_TOPICS.map((t) => t.id) as [
  BriefingTopic,
  ...BriefingTopic[],
];

const TOPIC_INDEX = new Map(BRIEFING_TOPICS.map((t, i) => [t.id, i]));

export function topicMeta(id: BriefingTopic) {
  return BRIEFING_TOPICS[TOPIC_INDEX.get(id) ?? 0];
}

/** Canonical render order, whatever order the model emitted. */
export function sortSections<T extends { topic: BriefingTopic }>(sections: T[]): T[] {
  return [...sections].sort(
    (a, b) => (TOPIC_INDEX.get(a.topic) ?? 99) - (TOPIC_INDEX.get(b.topic) ?? 99)
  );
}

/** Per video, so no single chatty creator dominates the briefing. */
export const MAX_NOTES_PER_VIDEO = 6;
/** Across the trip. Twenty videos × six notes is ~18KB of a stored trip, and
 *  trips are already close enough to localStorage's ceiling that photo names
 *  had to be dropped to make room (see Spot.morePhotoNames). Past ~100 notes
 *  the synthesis stops improving anyway — it's the same advice again. */
export const MAX_TRIP_NOTES = 100;

/** Truncated so one rambling quote can't cost a note's worth of storage. */
export const MAX_QUOTE_CHARS = 180;

export function trimQuote(quote: string): string {
  const q = quote.trim();
  return q.length <= MAX_QUOTE_CHARS ? q : `${q.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

/** Local rather than `merge.normalizeName`: merge.ts imports this module, and
 *  a sentence needs different flattening from a place name — punctuation and
 *  filler words are what make two identical tips look distinct. */
function normalizePoint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|a|an|is|are|to|of|in|on|it|you|your|and|be|will|can)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Folds one video's notes into the trip's set.
 *
 * Deduping is by (topic, normalized point) and it matters more than it looks:
 * twenty videos about the same country say "carry cash" twenty times, and
 * feeding twenty copies to the synthesizer buys nothing but tokens. Near-
 * duplicates that survive normalization ("bring cash", "cash is king") are the
 * synthesizer's job — that's the one thing it's genuinely good at.
 */
export function mergeNotes(trip: Trip, incoming: BriefingNote[] | undefined): number {
  if (!incoming?.length) return 0;
  const notes = (trip.notes ??= []);
  const seen = new Set(notes.map((n) => `${n.topic}|${normalizePoint(n.point)}`));
  let added = 0;
  for (const note of incoming) {
    if (notes.length >= MAX_TRIP_NOTES) break;
    const key = `${note.topic}|${normalizePoint(note.point)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
    added++;
  }
  return added;
}

/** Enough material to be worth a model call and a collapsed section at all.
 *  Three stray remarks make a briefing that's worse than no briefing. */
export const MIN_NOTES_FOR_BRIEFING = 5;

/** True when the trip has notes that the stored briefing doesn't reflect —
 *  never written, written by an older contract, or written before the last
 *  video landed. */
export function briefingIsStale(trip: Trip): boolean {
  const notes = trip.notes?.length ?? 0;
  if (notes < MIN_NOTES_FOR_BRIEFING) return false;
  const b = trip.briefing;
  if (!b) return true;
  return b.version !== BRIEFING_VERSION || b.fromNotes < notes;
}

/** A briefing worth rendering: right version, and at least one section. */
export function usableBriefing(trip: Trip): TripBriefing | null {
  const b = trip.briefing;
  if (!b || b.version !== BRIEFING_VERSION || b.sections.length === 0) return null;
  return b;
}
