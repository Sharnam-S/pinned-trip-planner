/**
 * Give the committed sample trips a "Before you go" briefing.
 *
 * The samples are the first — often only — trip a visitor opens, and they were
 * built before notes existed. Without this the feature is invisible on exactly
 * the maps we use to show the product off, and a real build would look like it
 * had grown a section the demo doesn't have.
 *
 * Notes can only come from transcripts, so this genuinely re-reads each
 * sample's videos. It does NOT re-extract spots: the sample maps are curated
 * and a full re-run would re-resolve two hundred pins through Google and quietly
 * reshuffle them. Only `notes` and `briefing` are ever written.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-briefings.mts            # report
 *   npx tsx --env-file=.env.local scripts/backfill-briefings.mts --write
 *   npx tsx --env-file=.env.local scripts/backfill-briefings.mts --only=373aac077066 --write
 *
 * Needs ANTHROPIC_API_KEY, and whatever the transcript fetch needs (see
 * lib/youtube.ts — the residential proxy). YouTube throttles a burst of caption
 * requests, so videos are read one at a time with a pause between; a video that
 * fails is skipped, not fatal.
 */
import fs from "fs";
import path from "path";
import { fetchVideoData } from "../lib/youtube";
import { extractNotes } from "../lib/extract";
import { synthesizeBriefing } from "../lib/briefingSynth";
import { MAX_NOTES_PER_VIDEO, mergeNotes, topicMeta, trimQuote } from "../lib/briefing";
import type { BriefingNote, Trip } from "../lib/types";

const DIR = path.join(process.cwd(), "data", "trips");
const WRITE = process.argv.includes("--write");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

/** YouTube's caption endpoint 429s on a burst; a build hitting that wall cost
 *  hours of debugging once already. Nothing here is time-critical. */
const PAUSE_MS = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function backfill(file: string) {
  const full = path.join(DIR, file);
  const trip: Trip = JSON.parse(fs.readFileSync(full, "utf8"));
  const destination = trip.query?.resolvedDestination ?? trip.destination?.name ?? trip.name;

  console.log(`\n=== ${trip.name} (${trip.id}) — ${trip.videos.length} videos`);
  if (trip.notes?.length) {
    console.log(`  already has ${trip.notes.length} notes; re-reading anyway`);
  }
  trip.notes = [];

  for (const video of trip.videos) {
    if (video.status !== "done") continue;
    try {
      const data = await fetchVideoData(video.id);
      const raw = await extractNotes(data);
      const notes: BriefingNote[] = raw.slice(0, MAX_NOTES_PER_VIDEO).map((n) => ({
        topic: n.topic,
        point: n.point.trim(),
        quote: trimQuote(n.quote),
        videoId: video.id,
        timestampSec: Math.max(0, Math.floor(n.timestamp_sec)),
      }));
      const added = mergeNotes(trip, notes);
      console.log(
        `  ${video.channelName || video.id}: ${raw.length} notes, ${added} new`
      );
    } catch (err) {
      // One unreadable video costs a few notes, not the briefing.
      console.log(
        `  ${video.id}: skipped — ${err instanceof Error ? err.message : err}`
      );
    }
    await sleep(PAUSE_MS);
  }

  const notes = trip.notes ?? [];
  console.log(`  → ${notes.length} notes total`);
  if (notes.length === 0) {
    console.log("  → nothing to synthesize");
    return;
  }

  const briefing = await synthesizeBriefing(notes, destination, {
    tripId: trip.id,
    tripName: trip.name,
  });
  if (!briefing) {
    console.log("  → synthesis returned nothing");
    return;
  }
  for (const s of briefing.sections) {
    const meta = topicMeta(s.topic);
    console.log(`\n  ${meta.emoji} ${meta.label}  [${s.sources.length} sources]`);
    console.log(`    ${s.summary}`);
  }
  trip.briefing = briefing;

  if (WRITE) {
    fs.writeFileSync(full, `${JSON.stringify(trip, null, 2)}\n`);
    console.log(`\n  written → ${file}`);
  }
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !ONLY || f.startsWith(ONLY));

if (files.length === 0) {
  console.error(`No sample trips matched${ONLY ? ` --only=${ONLY}` : ""}.`);
  process.exit(1);
}

for (const file of files) {
  await backfill(file);
}
if (!WRITE) console.log("\n(report only — pass --write to apply)");
