import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { VideoData, transcriptToText } from "./youtube";
import { buildTraceId, observedMessage, TripTag, tripProperties } from "./llm";
import {
  BRIEFING_TOPIC_IDS,
  BRIEFING_TOPICS,
  MAX_NOTES_PER_VIDEO,
} from "./briefing";

const ExtractedSpotSchema = z.object({
  name: z.string().describe("Canonical place name, e.g. 'Tegallalang Rice Terrace'"),
  // Required, and it must come BEFORE the category so the model commits to a
  // reason rather than rationalising a pick. Category drift was measurable on
  // the shipped sample trips: Galle Fort, Black Fort, Narikala Fortress and
  // Chronicles of Georgia all filed as "other"; a folk museum as "other";
  // beach clubs as "stay". The category filter chips are only as good as this
  // field, and it shows on the itinerary card as "Other · Food".
  category_reason: z
    .string()
    .describe(
      "One short clause naming what this place physically IS, which decides the category — 'a 17th-century fortification' → landmark, 'a beach bar with day beds' → nightlife, 'a guesthouse we slept at' → stay. If you can't finish this sentence, you don't understand the place well enough to include it."
    ),
  category: z.enum([
    "food",
    "nightlife",
    "nature",
    "beach",
    "viewpoint",
    "landmark",
    "museum",
    "activity",
    "wellness",
    "market",
    "shopping",
    "stay",
    "town",
    "other",
  ]),
  description: z
    .string()
    .describe(
      "2-3 sentence summary of what this spot is and why the creator recommends it, based only on what they said"
    ),
  timestamp_sec: z
    .number()
    .describe("Transcript timestamp (in seconds) where this spot is first discussed"),
  quote: z
    .string()
    .describe("Short verbatim-ish quote of what the creator said about it (max 1 sentence)"),
  things_to_know: z
    .array(z.string())
    .describe(
      "Practical tips or warnings the creator EXPLICITLY mentioned about this spot: safety (pickpockets, scams, stray dogs), best time to visit, tickets/price, dress code, booking ahead, how crowded it gets, what to bring. Each entry one short standalone sentence. Empty array if the creator gave none."
    ),
  geocode_query: z
    .string()
    .describe(
      "Search query for a geocoder, e.g. 'Suwat Waterfall, Gianyar, Bali, Indonesia'. Include region and country."
    ),
  lat: z.number().describe("Best-guess latitude of this spot from your own knowledge"),
  lng: z.number().describe("Best-guess longitude of this spot from your own knowledge"),
});

/** A remark about the DESTINATION rather than about a place — the half of every
 *  travel video that used to be read and thrown away. Same anti-hallucination
 *  lever as the spot mentions: a note must carry a quote and the second it was
 *  said at, so it can be audited in one click and can't be quietly sourced from
 *  the model's own priors about the country. */
const ExtractedNoteSchema = z.object({
  topic: z.enum(BRIEFING_TOPIC_IDS),
  point: z
    .string()
    .describe(
      "One standalone sentence a traveler can act on, in your own words, carrying the SPECIFICS the creator gave — numbers, names, amounts, times. 'Bolt is the default and a cross-town ride runs 5-8 lari' not 'transport is affordable'."
    ),
  quote: z
    .string()
    .describe("Short verbatim-ish quote of what the creator said (max 1 sentence)"),
  timestamp_sec: z
    .number()
    .describe("Transcript timestamp (in seconds) where this is said"),
});

const ExtractionSchema = z.object({
  destination: z.object({
    name: z.string().describe("The trip destination this video covers, e.g. 'Bali, Indonesia'"),
    lat: z.number().describe("Latitude of the destination center"),
    lng: z.number().describe("Longitude of the destination center"),
    zoom: z
      .number()
      .describe("Sensible initial map zoom for the destination: 10 for a region/island, 12 for a city"),
  }),
  spots: z.array(ExtractedSpotSchema),
  notes: z
    .array(ExtractedNoteSchema)
    .describe(
      "Destination-level advice the creator gave that is NOT about one specific place. Empty array when the video is a pure place list — that is a normal and correct answer, and padding it with generic travel wisdom is worse than returning nothing."
    ),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedSpot = z.infer<typeof ExtractedSpotSchema>;
export type ExtractedNote = z.infer<typeof ExtractedNoteSchema>;

/** Raised when a response can't be salvaged at all. Distinct from
 *  TranscriptError so the route can tell "the video is unreadable" from "we
 *  read it and couldn't make sense of the answer". */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

/** The same JSON Schema the model is generated against, minus the SDK's
 *  `parse`. Handing the SDK a zod parser makes it validate the whole response
 *  all-or-nothing and THROW — which cost us an entire transcript, twenty good
 *  spots and a bench slot because spot #9 came back with a category outside
 *  the enum. The schema still steers generation; we just do the checking
 *  ourselves, per item, below. */
function schemaOnly<T extends z.ZodType>(schema: T) {
  const format = zodOutputFormat(schema);
  // Dropping `parse` is what disarms the SDK: `maybeParseMessage` only
  // validates when the format carries one.
  return { type: format.type, schema: format.schema };
}

const CATEGORIES = new Set<string>(ExtractedSpotSchema.shape.category.options);
const TOPICS = new Set<string>(BRIEFING_TOPIC_IDS);

/** Only the destination has to be right for the video to be usable at all;
 *  spots and notes are checked one at a time so a single bad entry can't take
 *  the rest with it. */
const EnvelopeSchema = z.object({
  destination: ExtractionSchema.shape.destination,
  spots: z.array(z.unknown()).default([]),
  notes: z.array(z.unknown()).default([]),
});

/**
 * Salvaging parse. Returns everything the model got right and reports what it
 * didn't, rather than treating one malformed field as a dead video.
 */
export function parseExtraction(text: string, videoId: string): Extraction {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ExtractionError("Claude's answer for this video wasn't valid JSON.");
  }
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new ExtractionError(
      "Claude's answer for this video didn't have a usable destination."
    );
  }

  const spots: ExtractedSpot[] = [];
  let relabelled = 0;
  let droppedSpots = 0;
  for (const raw of envelope.data.spots) {
    if (!raw || typeof raw !== "object") {
      droppedSpots++;
      continue;
    }
    const candidate = { ...(raw as Record<string, unknown>) };
    // An unrecognised category is a LABELLING miss, not a bad spot — the name,
    // description and coordinates are all still good. Filing it as "other"
    // keeps a real recommendation on the map; dropping it loses one for the
    // sake of a chip.
    if (typeof candidate.category !== "string" || !CATEGORIES.has(candidate.category)) {
      candidate.category = "other";
      relabelled++;
    }
    const parsed = ExtractedSpotSchema.safeParse(candidate);
    if (parsed.success) spots.push(parsed.data);
    else droppedSpots++;
  }

  // A video that legitimately discusses no places is fine. A video whose spots
  // ALL failed to parse is structurally broken — fail it so the bench supplies
  // a replacement rather than silently contributing nothing.
  if (envelope.data.spots.length > 0 && spots.length === 0) {
    throw new ExtractionError(
      "None of the places in Claude's answer for this video were usable."
    );
  }

  const notes: ExtractedNote[] = [];
  let droppedNotes = 0;
  for (const raw of envelope.data.notes) {
    if (!raw || typeof raw !== "object") {
      droppedNotes++;
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    // Unlike a spot, a note with no valid topic has nowhere to go — the
    // briefing renders by topic — and notes are plentiful. Drop it.
    if (typeof candidate.topic !== "string" || !TOPICS.has(candidate.topic)) {
      droppedNotes++;
      continue;
    }
    const parsed = ExtractedNoteSchema.safeParse(candidate);
    if (parsed.success) notes.push(parsed.data);
    else droppedNotes++;
  }

  if (relabelled || droppedSpots || droppedNotes) {
    console.warn(
      `[extract] ${videoId}: salvaged — ${relabelled} spot(s) relabelled "other", ${droppedSpots} spot(s) and ${droppedNotes} note(s) dropped.`
    );
  }
  return { destination: envelope.data.destination, spots, notes };
}

/** Shared by the main extraction and by the notes-only pass the sample
 *  backfill uses, so the two can't drift into disagreeing about what a note is. */
const NOTE_RULES = `NOTES — what the creator said about the DESTINATION, not about a place:
Travel videos spend as much time orienting the viewer as they do listing places, and that half is what a traveler reads first. Capture it here.
- The split is simple: advice that only makes sense at one place goes in that spot's things_to_know; advice that would still be true if that place didn't exist goes in notes. "Go before 8am, the queue is brutal" is a spot tip. "Nowhere takes card below 20 lari" is a note.
- Topics (THESE ARE NOT SPOT CATEGORIES. A note's topic comes from this list; a spot's category comes from the list above. Never put a topic id in a spot's category — "food-drink" is a topic, "food" is a category, and they are not interchangeable):
${BRIEFING_TOPICS.map((t) => `  - ${t.id}: ${t.remit}`).join("\n")}
- TRANSCRIPT ONLY. You know a great deal about this destination already and NONE of it belongs here. If the creator didn't say it, it does not go in. A note whose quote you had to invent is a fabrication, not a summary.
- quote must be what was actually said, and timestamp_sec must come from the [seconds] markers where it was said. These are shown to the traveler as the receipt and are one click from the video.
- CARRY THE SPECIFICS. The value of a note is entirely in its numbers and names. "Getting around is easy" is worthless; "Bolt is everywhere and a cross-town ride is 5-8 lari, but drivers rarely speak English" is the note. If a remark has no specific in it, drop it.
- NEVER WRITE THESE, they are the generic filler that makes a briefing worth skipping: "the culture is rich and vibrant", "the locals are very friendly and welcoming", "there's something for everyone", "be respectful of local customs", "always stay aware of your surroundings", "try the local cuisine". Every one of those is true of everywhere.
- No place recommendations in notes, ever. A note naming a restaurant, a beach or a hotel belongs in spots.
- Skip sponsor reads, gear plugs, discount codes, channel promotion and anything about making the video itself.
- For safety, keep the distinction the creator drew — solo versus with people, day versus night, women travelling alone — rather than averaging it into "it's generally safe".
- Aim for the ${MAX_NOTES_PER_VIDEO} strongest notes at most. Fewer, specific, quotable notes beat a long padded list, and an empty array is the right answer for a video that only lists places.`;

// Override with EXTRACT_MODEL in .env.local (e.g. claude-haiku-4-5) to trade
// extraction quality for cost. `||`, not `??`: .env files set absent keys to the
// EMPTY STRING, which `??` happily passes through — and an empty model id makes
// every extraction 400 while the UI blames the video for having no captions.
const DEFAULT_MODEL = process.env.EXTRACT_MODEL || "claude-sonnet-4-6";

export async function extractSpots(
  video: VideoData,
  knownSpotNames: string[],
  model: string = DEFAULT_MODEL,
  trip?: TripTag
): Promise<Extraction> {
  const transcriptText = transcriptToText(video.transcript);

  const knownBlock =
    knownSpotNames.length > 0
      ? `\n\nSpots already found in other videos for this trip:\n${knownSpotNames
          .map((n) => `- ${n}`)
          .join(
            "\n"
          )}\nIf a place in this transcript is the same as one of these, reuse the EXACT same name string so it can be merged.`
      : "";

  const message = await observedMessage({
    model,
    max_tokens: 32000,
    // Adaptive thinking is a 4.6+ feature — Haiku 4.5 rejects it
    ...(model.includes("haiku") ? {} : { thinking: { type: "adaptive" as const } }),
    system: `You extract travel recommendations from YouTube video transcripts for a trip-planning app.

Rules:
- Only include real, physical, visitable places the creator actually visited or recommended: restaurants, bars, waterfalls, beaches, cultural/historic sites, viewpoints, activities (swings, rafting, hikes), spas, markets, villas/airbnbs/hotels they stayed at or recommended, towns/neighborhoods worth basing in.
- Pick the SINGLE category that best fits what the place physically is. Category guide:
  - food: places to eat — restaurants, cafes, warungs, street-food stalls, bakeries, food halls.
  - nightlife: places to go out after dark — bars, cocktail lounges, pubs, clubs, rooftop and live-music venues.
  - nature: natural sites — waterfalls, jungles, rice terraces, lakes, rivers, caves, parks, gardens, wildlife spots.
  - beach: beaches and coastal swimming/surf spots.
  - viewpoint: lookouts and scenic vantage points valued mainly for the view.
  - landmark: outdoor cultural, historic, religious or architectural sights — temples, churches, cathedrals, mosques, monasteries, shrines, castles, fortresses, palaces, ruins, monuments, statues, historic old towns. Use this for ALL places of worship and heritage sites regardless of religion or region (a Georgian Orthodox cathedral, a Japanese shrine, and a Balinese temple are all "landmark").
  - museum: indoor cultural venues — museums, art galleries, exhibitions, planetariums.
  - activity: things you DO — hikes, rafting, ziplines, swings, diving/snorkelling, boat trips, guided tours, classes, theme/water parks, zoos, aquariums.
  - wellness: spas, onsen/hot springs, hammams, thermal baths, saunas, yoga/wellness retreats, massage.
  - market: markets and bazaars — night markets, local/street markets, flea markets, souks.
  - shopping: individual shops, boutiques, malls, and design/craft stores (not markets).
  - stay: accommodation — Airbnbs, villas, hostels, hotels, resorts.
  - town: towns, villages, or neighborhoods worth basing in or wandering.
  - other: anything real and visitable that fits none of the above.
- Classify by what a place physically is, not by a religion-specific reading (a historic fortress is a "landmark", not an "activity").
- "other" IS A LAST RESORT. If more than one spot in ten lands in "other", you have mis-categorised — re-read the guide above. A fort, a fortress, a city wall, a monument, a historic square and a cathedral are ALL "landmark". A folk museum is "museum".
- "stay" MEANS SOMEWHERE YOU SLEEP. A beach club, day club, rooftop bar or restaurant attached to a hotel is not a "stay" — categorise it by what you actually do there (nightlife, food, beach).
- NEVER PIN THESE, however often they're mentioned: convenience stores and chains (7-Eleven, Family Mart, Starbucks), petrol stations, ATMs and banks, airports and bus stations, unnamed accommodation ("the Airbnb we stayed at", "our hotel"), and anything the creator only passed through. A traveler cannot act on them and they crowd out real recommendations.
- Skip generic mentions, sponsors, and places outside the trip destination. If a video about one city spends time somewhere hours away, that place is not part of this trip.
- Transcripts are auto-generated and garble proper nouns. Use your knowledge of the destination to recover the real place name (e.g. "tega lalang" -> "Tegallalang Rice Terrace"). If you cannot confidently identify a real place, skip it.
- timestamp_sec must come from the [seconds] markers in the transcript where the place is first properly discussed.
- lat/lng: give your best-guess coordinates from knowledge. For obscure places, approximate within the correct area.
- things_to_know: capture practical advice and warnings the creator actually states (e.g. "popular with pickpockets, watch your bag", "go before 8am to beat crowds", "cash only", "knees must be covered"). Do not invent tips from general knowledge — transcript only.

${NOTE_RULES}`,
    messages: [
      {
        role: "user",
        content: `Video title: ${video.title}\nCreator: ${video.channelName}${knownBlock}\n\nTranscript (each line prefixed with [seconds]):\n\n${transcriptText}`,
      },
    ],
    output_config: {
      format: schemaOnly(ExtractionSchema),
    },
  }, {
    spanName: "extract-spots",
    // Every video read for one trip belongs to that trip's build trace, not to
    // a trace of its own — see buildTraceId. The video id remains the CACHE
    // key; it just stopped being the trace id. Falls back to the video when
    // there's no trip (scripts, one-off reprocessing).
    traceId: buildTraceId(trip) ?? `video-${video.id}`,
    stream: true,
    // Extractions are cached cross-trip, so the trip tag names the trip that
    // paid for this call; later trips reuse the cache at zero LLM cost.
    properties: {
      videoId: video.id,
      videoTitle: video.title,
      channel: video.channelName,
      ...tripProperties(trip),
    },
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new ExtractionError("Claude returned nothing for this video.");
  }
  return parseExtraction(textBlock.text, video.id);
}

const NotesOnlySchema = z.object({ notes: z.array(ExtractedNoteSchema) });

/**
 * Notes only, from a transcript whose spots were already extracted.
 *
 * Exists for the sample backfill: the five committed sample trips were built
 * before briefings, so re-running the full extraction on them would re-resolve
 * 200-odd spots through Google and rewrite maps that are deliberately curated.
 * This reads the same transcripts under the same rules and returns only the
 * new half.
 */
export async function extractNotes(
  video: VideoData,
  model: string = DEFAULT_MODEL,
  trip?: TripTag
): Promise<ExtractedNote[]> {
  const message = await observedMessage(
    {
      model,
      max_tokens: 8000,
      system: `You read a YouTube travel video transcript and pull out what the creator said about the DESTINATION — the orientation a traveler needs before they start planning, as opposed to the list of places, which has already been captured elsewhere.

${NOTE_RULES}`,
      messages: [
        {
          role: "user",
          content: `Video title: ${video.title}\nCreator: ${video.channelName}\n\nTranscript (each line prefixed with [seconds]):\n\n${transcriptToText(video.transcript)}`,
        },
      ],
      output_config: { format: schemaOnly(NotesOnlySchema) },
    },
    {
      spanName: "extract-notes",
      traceId: buildTraceId(trip) ?? `video-${video.id}`,
      stream: true,
      properties: {
        videoId: video.id,
        videoTitle: video.title,
        channel: video.channelName,
        ...tripProperties(trip),
      },
    }
  );
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];
  // Same salvage as the main pass — reuse it by handing it an empty spot list.
  return parseExtraction(
    JSON.stringify({
      destination: { name: "", lat: 0, lng: 0, zoom: 10 },
      spots: [],
      notes: (JSON.parse(textBlock.text) as { notes?: unknown }).notes ?? [],
    }),
    video.id
  ).notes;
}
