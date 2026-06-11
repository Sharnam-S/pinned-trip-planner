import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { VideoData, transcriptToText } from "./youtube";

const client = new Anthropic();

const ExtractedSpotSchema = z.object({
  name: z.string().describe("Canonical place name, e.g. 'Tegallalang Rice Terrace'"),
  category: z.enum([
    "food",
    "nature",
    "beach",
    "temple",
    "activity",
    "viewpoint",
    "stay",
    "shopping",
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

export async function extractSpots(
  video: VideoData,
  knownSpotNames: string[]
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

  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: `You extract travel recommendations from YouTube video transcripts for a trip-planning app.

Rules:
- Only include real, physical, visitable places the creator actually visited or recommended: restaurants/warungs, waterfalls, beaches, temples, viewpoints, activities (swings, rafting, hikes), villas/airbnbs/hotels they stayed at or recommended, markets, towns/neighborhoods worth basing in.
- Accommodation (Airbnbs, villas, hostels, hotels) gets category "stay".
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
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content for extraction.");
  }
  return ExtractionSchema.parse(JSON.parse(textBlock.text));
}
