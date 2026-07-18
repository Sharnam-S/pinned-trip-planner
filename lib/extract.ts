import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { VideoData, transcriptToText } from "./youtube";
import { observedMessage, TripTag, tripProperties } from "./llm";

const ExtractedSpotSchema = z.object({
  name: z.string().describe("Canonical place name, e.g. 'Tegallalang Rice Terrace'"),
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
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedSpot = z.infer<typeof ExtractedSpotSchema>;

// Override with EXTRACT_MODEL in .env.local (e.g. claude-haiku-4-5) to trade
// extraction quality for cost.
const DEFAULT_MODEL = process.env.EXTRACT_MODEL ?? "claude-sonnet-4-6";

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
- Skip generic mentions (e.g. "the airport", "our hotel" with no name), sponsors, and places outside the trip destination.
- Transcripts are auto-generated and garble proper nouns. Use your knowledge of the destination to recover the real place name (e.g. "tega lalang" -> "Tegallalang Rice Terrace"). If you cannot confidently identify a real place, skip it.
- timestamp_sec must come from the [seconds] markers in the transcript where the place is first properly discussed.
- lat/lng: give your best-guess coordinates from knowledge. For obscure places, approximate within the correct area.
- things_to_know: capture practical advice and warnings the creator actually states (e.g. "popular with pickpockets, watch your bag", "go before 8am to beat crowds", "cash only", "knees must be covered"). Do not invent tips from general knowledge — transcript only.`,
    messages: [
      {
        role: "user",
        content: `Video title: ${video.title}\nCreator: ${video.channelName}${knownBlock}\n\nTranscript (each line prefixed with [seconds]):\n\n${transcriptText}`,
      },
    ],
    output_config: {
      format: zodOutputFormat(ExtractionSchema),
    },
  }, {
    spanName: "extract-spots",
    // One extraction per video and results are cached cross-trip, so the
    // video id is the natural trace id.
    traceId: `video-${video.id}`,
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
    throw new Error("Claude returned no text content for extraction.");
  }
  return ExtractionSchema.parse(JSON.parse(textBlock.text));
}
