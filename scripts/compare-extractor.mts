/**
 * A/B test: re-extract one already-processed video with a cheaper model and
 * compare against the Sonnet baseline stored in the trip file.
 *
 * Usage: npx tsx scripts/compare-extractor.mts <tripId> <videoId> [model]
 */
import fs from "fs";
import path from "path";

// Load .env.local before importing anything that constructs an Anthropic client
const envFile = path.join(process.cwd(), ".env.local");
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { fetchVideoData } = await import("../lib/youtube");
const { extractSpots } = await import("../lib/extract");

const [tripId, videoId, model = "claude-haiku-4-5"] = process.argv.slice(2);
const trip = JSON.parse(
  fs.readFileSync(path.join("data", "trips", `${tripId}.json`), "utf8")
);

// Sonnet baseline: spots this video contributed (any spot it's a mention of)
const baseline = trip.spots.filter((s: any) =>
  s.mentions.some((m: any) => m.videoId === videoId)
);

console.log(`Fetching transcript for ${videoId}…`);
const video = await fetchVideoData(videoId);
console.log(`"${video.title}" — running extraction with ${model}…`);

const t0 = Date.now();
const result = await extractSpots(video, [], model);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const baseNames = new Set(baseline.map((s: any) => norm(s.name)));
const newNames = new Set(result.spots.map((s) => norm(s.name)));

const matched = [...newNames].filter((n) => baseNames.has(n));
const missed = baseline.filter((s: any) => !newNames.has(norm(s.name)));
const extra = result.spots.filter((s) => !baseNames.has(norm(s.name)));

// Coordinate sanity: distance from the model's guess to the final (Google)
// coords of the matching baseline spot. Only needs to be <150km to work.
const dist = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const R = 6371, dLat = ((bLat - aLat) * Math.PI) / 180, dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const coordChecks = result.spots
  .map((s) => {
    const b = baseline.find((x: any) => norm(x.name) === norm(s.name));
    return b ? { name: s.name, km: Math.round(dist(s.lat, s.lng, b.lat, b.lng)) } : null;
  })
  .filter(Boolean) as { name: string; km: number }[];

console.log(`\n=== ${model} vs stored Sonnet baseline ===`);
console.log(`Wall time: ${secs}s`);
console.log(`Destination: ${result.destination.name}`);
console.log(`Spots found: ${result.spots.length} (baseline contributed to: ${baseline.length})`);
console.log(`Name matches with baseline: ${matched.length}`);
console.log(`Missed (in baseline, not found): ${missed.map((s: any) => s.name).join(", ") || "none"}`);
console.log(`New/different names: ${extra.map((s) => s.name).join(", ") || "none"}`);
console.log(`Coord guesses within 150km of truth: ${coordChecks.filter((c) => c.km <= 150).length}/${coordChecks.length}`);
const worst = coordChecks.sort((a, b) => b.km - a.km)[0];
if (worst) console.log(`Worst coord guess: ${worst.name} (${worst.km}km off)`);

console.log(`\nSample of extracted spots:`);
for (const s of result.spots.slice(0, 5)) {
  console.log(`- [${s.category}] ${s.name} @${s.timestamp_sec}s`);
  console.log(`    "${s.quote}"`);
  if (s.things_to_know.length) console.log(`    tips: ${s.things_to_know.join(" | ")}`);
}
