/**
 * Turns a trip's raw creator notes into the briefing rendered above the pins.
 *
 * Server-only (Anthropic SDK) — the shared half lives in `briefing.ts`.
 *
 * Why a model call at all, when the notes are already sentences: twenty videos
 * about one country say the same eight things. Rendering the raw pile gives a
 * traveler "carry cash" nine times in slightly different words, which reads as
 * padding and teaches them to skip the section. Merging near-duplicates while
 * keeping the specifics is the one job a model is unambiguously good at. It's
 * one call at the end of a build that already spent twenty extraction calls,
 * and it runs after the map is interactive, so it costs the traveler nothing
 * in perceived time.
 */
import { z } from "zod";
import {
  BRIEFING_TOPIC_IDS,
  BRIEFING_TOPICS,
  BRIEFING_VERSION,
  MIN_NOTES_FOR_BRIEFING,
  sortSections,
  topicMeta,
} from "./briefing";
import {
  buildTraceId,
  observedMessage,
  schemaOnly,
  TripTag,
  tripProperties,
} from "./llm";
import { BriefingNote, BriefingSection, TripBriefing } from "./types";

// Judgment-heavy and small, like discover.ts — the traveler reads this before
// anything else on the page, so it doesn't go on the cheap model.
const MODEL = process.env.BRIEFING_MODEL || "claude-sonnet-4-6";

/** Hard ceiling on bullets per section. The prompt asks for 2-5; this is what
 *  happens when it doesn't listen. Six bullets on one topic is the padding the
 *  whole section is written to avoid, and clamping is cheaper than a retry. */
const MAX_POINTS_PER_SECTION = 5;

const SectionSchema = z.object({
  topic: z.enum(BRIEFING_TOPIC_IDS),
  // Deliberately unbounded in the schema: an array length is exactly the kind
  // of near-miss that would throw the whole briefing away (§4.10). The count is
  // asked for in prose and clamped in code.
  points: z
    .array(z.string())
    .describe(
      "2-5 bullets merging everything the creators said on this topic. ONE idea per bullet, one sentence each, the specific fact first. Keep every number, name, amount, time and app name. No bullet markers, no headings — just the sentence. Where creators disagreed, that's its own bullet ('most said X; one found Y')."
    ),
  source_video_ids: z
    .array(z.string())
    .describe(
      "The ids of the videos whose notes these bullets are built from, most substantial first. Copy them exactly from the input — do not invent ids."
    ),
});

const BriefingSchema = z.object({
  sections: z
    .array(SectionSchema)
    .describe(
      "One section per topic that has genuine material, in any order. Omit every topic that doesn't."
    ),
});

/**
 * Writes the briefing. Returns null when there isn't enough to say — the
 * caller stores nothing and the section simply doesn't render.
 */
export async function synthesizeBriefing(
  notes: BriefingNote[],
  destination: string,
  trip?: TripTag
): Promise<TripBriefing | null> {
  if (notes.length < MIN_NOTES_FOR_BRIEFING) return null;

  // Grouped by topic in the prompt so the model compares like with like
  // instead of rediscovering the grouping it was already given.
  const byTopic = new Map<string, BriefingNote[]>();
  for (const n of notes) {
    const list = byTopic.get(n.topic);
    if (list) list.push(n);
    else byTopic.set(n.topic, [n]);
  }
  const notesBlock = BRIEFING_TOPICS.filter((t) => byTopic.has(t.id))
    .map((t) => {
      const lines = byTopic
        .get(t.id)!
        .map((n) => `  - [${n.videoId}] ${n.point}\n    said as: "${n.quote}"`)
        .join("\n");
      return `## ${t.id} — ${t.label}\n${lines}`;
    })
    .join("\n\n");

  const message = await observedMessage(
    {
      model: MODEL,
      max_tokens: 8000,
      system: `You write the short orientation briefing a traveler reads before they start planning a trip to ${destination}.

Your ONLY source is the notes below, harvested from the YouTube travel videos this traveler's map was built from. Each note is tagged with the video it came from and the words the creator actually used.

What this section is for:
Every one of these travelers already has a map of places to go. What they don't have is the thing a friend who has been there tells you in five minutes — how you pay for things, whether the tap water is fine, that everything shuts on Sunday, that the taxi drivers at the airport are the one scam worth knowing. That is what you are writing.

Rules:
- BULLETS, NOT PARAGRAPHS. This gets skimmed once, standing in an airport, before any planning starts. Each section is 2-5 separate bullets and each bullet is ONE idea in ONE sentence. A traveler must be able to read any single bullet on its own, out of order, and get the whole point of it.
- LEAD WITH THE FACT, NOT THE SETUP. "Sarong required at every temple — handed to you free at the entrance" beats "When visiting temples in Bali, you should be aware that a sarong is required." Cut every "it's worth noting that", "keep in mind", "travelers should".
- KEEP BULLETS SHORT — about 25 words. Two clauses joined by a dash or semicolon is fine; a second full sentence means it was two bullets.
- USE ONLY THE NOTES. You know a great deal about ${destination}; none of it belongs here. Every claim must be traceable to a note. If the notes don't cover a topic, that topic does not appear — an absent section is correct and expected.
- OMIT THIN TOPICS. A topic that cannot fill two real bullets is not a section. Four sections that each tell the traveler something they didn't know beat twelve that pad. This is the single most important instruction here: a briefing that pads is one the traveler learns to collapse and never open again.
- SPECIFICS ARE THE WHOLE VALUE. Keep the numbers, prices, app names, hours, neighbourhood names, phrases. Strip the adjectives. "Bolt is the default; a cross-town ride is 5-8 lari" is a bullet worth reading. "Getting around is easy and affordable" is not, and neither is any bullet you could have written without reading the notes.
- MERGE, DON'T LIST. Nine creators saying "bring cash" is ONE bullet, not nine. But when they disagree, keep the disagreement — it gets its own bullet, because it's information, not noise.
- BANNED, because they are true of everywhere: "rich culture", "vibrant atmosphere", "friendly locals", "something for everyone", "be respectful of local customs", "stay aware of your surroundings", "immerse yourself", "hidden gem". If a bullet survives deleting its adjectives, it wasn't saying anything.
- NO PLACE RECOMMENDATIONS. The map already lists the places. A section that turns into "visit X, then Y" has missed the point. Naming a place as an example of a general point is fine ("the Sunday market in Dezerter Bazaar is cash-only, like most markets here").
- For safety, preserve the distinctions creators drew — alone versus with people, day versus night, women travelling alone. Averaging that into "it's generally safe" is the failure mode, and those distinctions usually want a bullet each.
- Second person, plain and direct. No headings, no emoji, and no bullet markers in the text ("-", "•", "1.") — the list is rendered for you. Just say the thing.

The topics you may use, and their remit:
${BRIEFING_TOPICS.map((t) => `- ${t.id} (${t.label}): ${t.remit}`).join("\n")}`,
      messages: [
        {
          role: "user",
          content: `Destination: ${destination}\nNotes from ${new Set(notes.map((n) => n.videoId)).size} videos:\n\n${notesBlock}`,
        },
      ],
      output_config: { format: schemaOnly(BriefingSchema) },
    },
    {
      spanName: "briefing",
      // Same build trace as the extractions it was written from.
      traceId: buildTraceId(trip) ?? `briefing-${destination}`,
      properties: { destination, notes: notes.length, ...tripProperties(trip) },
    }
  );

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;
  // Section by section, not all-or-nothing (§4.10): one unrecognised topic id
  // or one malformed entry should cost that section, not the whole briefing.
  const raw: unknown = JSON.parse(textBlock.text);
  const rawSections = Array.isArray((raw as { sections?: unknown })?.sections)
    ? ((raw as { sections: unknown[] }).sections)
    : [];

  // Resolve the model's video ids back to real notes. An id it invented
  // resolves to nothing and is dropped rather than rendered as a dead
  // "watch the clip" link — the sources are the section's credibility, and a
  // broken one costs more than a missing one.
  const firstMention = new Map<string, BriefingNote>();
  for (const n of notes) if (!firstMention.has(n.videoId)) firstMention.set(n.videoId, n);

  const sections: BriefingSection[] = [];
  for (const item of rawSections) {
    const ok = SectionSchema.safeParse(item);
    if (!ok.success) continue;
    const s = ok.data;
    // Strip any bullet marker the model wrote anyway — the list renders its
    // own, and a stray "- " reads as a bug.
    const points = s.points
      .map((p) => p.trim().replace(/^[-•*]\s*|^\d+[.)]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, MAX_POINTS_PER_SECTION);
    if (points.length === 0) continue;
    const sources = [...new Set(s.source_video_ids)]
      .map((id) => firstMention.get(id))
      .filter((n): n is BriefingNote => Boolean(n))
      .map((n) => ({ videoId: n.videoId, timestampSec: n.timestampSec }));
    if (sources.length === 0) continue; // unattributable — don't show it
    sections.push({ topic: s.topic, points, sources });
  }
  if (sections.length === 0) return null;

  // Last-ditch dedupe: two sections on one topic means the model ignored the
  // schema's "one per topic", and rendering both looks like a bug.
  const seen = new Set<string>();
  const unique = sections.filter((s) =>
    seen.has(s.topic) ? false : (seen.add(s.topic), true)
  );

  return {
    version: BRIEFING_VERSION,
    updatedAt: new Date().toISOString(),
    fromNotes: notes.length,
    sections: sortSections(unique),
  };
}

/** Exported for the sample-backfill script's dry-run output. */
export function describeBriefing(b: TripBriefing): string {
  return b.sections
    .map((s) =>
      [
        `  ${topicMeta(s.topic).emoji} ${topicMeta(s.topic).label}`,
        ...s.points.map((p) => `    · ${p}`),
      ].join("\n")
    )
    .join("\n");
}
