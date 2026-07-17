/**
 * Search-mode video discovery: turn (destination, dates, interests) into a
 * ranked list of YouTube videos worth extracting.
 *
 * The two LLM calls here are tiny but judgment-heavy — query quality and video
 * selection compound through everything downstream — so they run on Sonnet.
 * The big-token transcript extraction stays on the cheap model (extract.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { searchVideos, SearchCandidate } from "./youtube";
import { TripQuery } from "./types";

const client = new Anthropic();
const PLANNER_MODEL = "claude-sonnet-4-6";

const PlanSchema = z.object({
  resolvedDestination: z
    .string()
    .describe(
      "The fully-qualified destination, e.g. 'Tbilisi, Georgia'. Resolve ambiguous input to the most likely travel destination."
    ),
  seasonContext: z
    .string()
    .nullable()
    .describe(
      "When travel dates are given: 1-2 sentences on what that time of year is like at this destination — weather, what's open or closed, and what's seasonally special (ski season, monsoon, festivals, Christmas markets). null when no dates were given or the season changes nothing there."
    ),
  queries: z
    .array(z.string())
    .min(3)
    .max(6)
    .describe("YouTube search queries, diverse in angle"),
});

export type SearchPlan = z.infer<typeof PlanSchema>;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-12-04".."2026-12-18" -> "December"; a span -> "June to August". */
function travelMonths(startDate?: string, endDate?: string): string | null {
  const monthOf = (d?: string) => {
    const n = d ? Number(d.slice(5, 7)) : NaN;
    return n >= 1 && n <= 12 ? MONTHS[n - 1] : null;
  };
  const a = monthOf(startDate);
  const b = monthOf(endDate);
  if (a && b) return a === b ? a : `${a} to ${b}`;
  return a ?? b;
}

/** Shared context lines for both LLM calls: dates annotated with month names,
 *  plus today's date so "recent" and "this coming winter" mean something. */
function queryContextLines(query: TripQuery): string[] {
  const parts: string[] = [];
  parts.push(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
  if (query.startDate || query.endDate) {
    const months = travelMonths(query.startDate, query.endDate);
    parts.push(
      `Travel dates: ${query.startDate ?? "?"} to ${query.endDate ?? "?"}` +
        (months ? ` (${months})` : "")
    );
  }
  if (query.interests) parts.push(`Traveler's interests: ${query.interests}`);
  return parts;
}

export async function planSearchQueries(query: TripQuery): Promise<SearchPlan> {
  const parts = [`Destination: ${query.destination}`, ...queryContextLines(query)];

  const response = await client.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 2000,
    system: `You plan YouTube searches for a travel app that extracts recommended spots from video transcripts.

Given a destination (and optionally travel dates and interests), produce 4-6 YouTube search queries that together will surface the best travel videos:
- Always include 2-3 general coverage queries (travel guide, things to do, where to stay/eat).
- If travel dates are given, first work out what that time of year is like at the destination (hemisphere-aware: June is winter in Patagonia) and record it in seasonContext. What's worth doing often changes completely with the season — Switzerland in June means hiking, lakes, and alpine passes; in December it means skiing and Christmas markets. Dedicate 1-2 queries to that season, phrased like real video titles ("Switzerland in December", "Zermatt winter vlog"), and when the season strongly reshapes the trip, season-flavor a general query too ("Switzerland winter travel guide" rather than "Switzerland travel guide").
- Treat notable seasonal events inside the travel window (festivals, Christmas markets, cherry blossom, harvest) as implicit interests even when the traveler listed none.
- If interests are given, devote roughly half the queries to them (e.g. interest "skiing" near Tbilisi -> "Gudauri skiing vlog") — but never ALL queries; general coverage must remain.
- Resolve ambiguous destinations to the most likely travel destination and write queries against the resolved name.
- Queries should be phrased the way real travel-video titles are phrased.`,
    messages: [{ role: "user", content: parts.join("\n") }],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Search planner returned no output.");
  return PlanSchema.parse(JSON.parse(text.text));
}

/** Run all searches, merge, and apply cheap heuristic filters. */
export async function gatherCandidates(queries: string[]): Promise<SearchCandidate[]> {
  const results = await Promise.all(
    queries.map((q) => searchVideos(q).catch(() => [] as SearchCandidate[]))
  );
  const byId = new Map<string, SearchCandidate>();
  for (const list of results) {
    for (const c of list) {
      if (byId.has(c.id)) continue;
      // No Shorts, no monsters: 4-40 min is the sweet spot for travel guides
      if (c.durationSec < 240 || c.durationSec > 2400) continue;
      byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

const CurationSchema = z.object({
  videoIds: z
    .array(z.string())
    .describe(
      "Ranked YouTube video ids from the candidate list, best first, up to 16. Only ids that appear in the list."
    ),
});

/**
 * Rank candidates: the top 8 become the trip, the rest are the bench for
 * substitution when a pick turns out to have no captions.
 */
export async function curateVideos(
  candidates: SearchCandidate[],
  query: TripQuery,
  plan: SearchPlan
): Promise<string[]> {
  // Keep the prompt small — 60 candidates is plenty of signal
  const list = candidates.slice(0, 60);
  const lines = list
    .map(
      (c) =>
        `${c.id} | ${Math.round(c.durationSec / 60)}min | ${c.views} | ${c.published} | ${c.channelName} | ${c.title}`
    )
    .join("\n");

  const context = [
    `Destination: ${plan.resolvedDestination}`,
    ...queryContextLines(query),
    plan.seasonContext ? `Season at destination: ${plan.seasonContext}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 1500,
    system: `You pick the best YouTube travel videos for spot extraction. From the candidate list, return a ranked list of up to 16 video ids (best first).

Ranking criteria:
- Actual travel content about the destination: guides, vlogs, "things to do", food tours. Reject news, real-estate, expat-life rants, generic country compilations where the destination is one stop among many.
- The first 8 must come from 8 DIFFERENT channels — they become the trip; diversity of perspective is the product's core value.
- When travel dates are given, match the season: infer the season a video covers from its title and its published month (a vlog published in July was almost certainly filmed in summer). Favor same-season and evergreen videos; demote wrong-season ones — a summer hiking vlog is a poor guide for a December trip, and vice versa. Keep a wrong-season video only when it's clearly the best general guide available. Without dates, lean season-neutral.
- Cover the traveler's interests when given, but keep general coverage in the first 8 too.
- Prefer recent over old (places close), substantial over thin (a 15-min detailed guide beats a 4-min montage), and watched over unwatched — but a niche creator with exactly the right content beats a generic popular one.
- Ranks 9-16 are backups used when a pick has no captions: same standards, just next-best.`,
    messages: [
      {
        role: "user",
        content: `${context}\n\nCandidates (id | duration | views | published | channel | title):\n${lines}`,
      },
    ],
    output_config: { format: zodOutputFormat(CurationSchema) },
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Video curation returned no output.");
  const parsed = CurationSchema.parse(JSON.parse(text.text));
  // Guard against hallucinated ids
  const valid = new Set(list.map((c) => c.id));
  return parsed.videoIds.filter((id) => valid.has(id));
}
