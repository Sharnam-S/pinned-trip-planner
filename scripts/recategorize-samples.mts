/**
 * Re-categorise the committed sample trips against the tightened extraction
 * rules, and drop the spots those rules now exclude.
 *
 * The samples are the first thing a visitor sees, and they carry the drift the
 * new rules exist to stop: Galle Fort, Black Fort, Narikala Fortress and
 * Chronicles of Georgia all filed as "other"; a folk museum as "other"; beach
 * clubs (Kai, Tennis, Petty Petty) as "stay"; a 7-Eleven corner and an unnamed
 * Airbnb pinned as places to go. That reaches the traveler — the Day 1 card on
 * the flagship Sri Lanka trip reads "Other · Food".
 *
 * Categories only. Names, coordinates, photos, mentions and descriptions are
 * left exactly as they are: this is a relabelling pass, not a re-extraction, so
 * it costs one small model call per trip and can't invent anything.
 *
 *   npx tsx scripts/recategorize-samples.mts            # report only
 *   npx tsx scripts/recategorize-samples.mts --write    # apply
 */
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const DIR = path.join(process.cwd(), "data", "trips");
const WRITE = process.argv.includes("--write");

const CATEGORIES = [
  "food", "nightlife", "nature", "beach", "viewpoint", "landmark", "museum",
  "activity", "wellness", "market", "shopping", "stay", "town", "other",
] as const;

const Schema = z.object({
  spots: z.array(
    z.object({
      id: z.string(),
      category: z.enum(CATEGORIES),
      reason: z.string().describe("One clause: what this place physically is."),
      drop: z
        .boolean()
        .describe(
          "true only for things a traveler cannot act on: convenience stores and chains, petrol stations, ATMs, airports and bus stations, and unnamed accommodation."
        ),
    })
  ),
});

const SYSTEM = `You are re-checking the category on already-extracted travel spots. For each spot you get its name and the description written from the creator's own words.

Category guide (pick the SINGLE category for what the place physically IS):
- food: restaurants, cafes, warungs, street-food stalls, bakeries, food halls.
- nightlife: bars, cocktail lounges, pubs, clubs, beach/day clubs, rooftop and live-music venues.
- nature: waterfalls, jungles, rice terraces, lakes, rivers, caves, parks, gardens, wildlife spots, national parks.
- beach: beaches and coastal swimming/surf spots.
- viewpoint: lookouts and vantage points valued mainly for the view.
- landmark: ALL outdoor cultural, historic, religious and architectural sights — temples, churches, cathedrals, mosques, monasteries, shrines, castles, FORTRESSES and FORTS, palaces, ruins, monuments, statues, historic squares and old towns.
- museum: museums, galleries, exhibitions, planetariums — including folk and heritage museums.
- activity: things you DO — hikes, rafting, ziplines, swings, diving, boat trips, tours, classes, theme parks, zoos, aquariums.
- wellness: spas, onsen, hot springs, hammams, thermal baths, saunas, yoga retreats, massage.
- market: markets and bazaars.
- shopping: individual shops, boutiques, malls, craft stores.
- stay: SOMEWHERE YOU SLEEP — hotels, hostels, guesthouses, resorts, villas, Airbnbs. A beach club or restaurant attached to a hotel is NOT a stay.
- town: towns, villages or neighbourhoods worth basing in or wandering.
- other: LAST RESORT. If more than one spot in ten lands here, you have mis-categorised.

Set drop=true only for things a traveler cannot act on: convenience stores and chains (7-Eleven, Family Mart), petrol stations, ATMs, airports, bus stations, and unnamed accommodation ("the Airbnb we stayed at").

Return every spot you were given, once, with its id unchanged.`;

const client = new Anthropic();

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const full = path.join(DIR, file);
  const trip = JSON.parse(fs.readFileSync(full, "utf8"));
  const list = trip.spots.map(
    (s: { id: string; name: string; category: string; description: string }) =>
      `${s.id} | ${s.name} | now: ${s.category} | ${String(s.description).slice(0, 200)}`
  );

  const res = await client.messages.create({
    model: process.env.EXTRACT_MODEL || "claude-sonnet-4-6",
    max_tokens: 16000,
    system: SYSTEM,
    messages: [
      { role: "user", content: `Spots (id | name | current category | description):\n${list.join("\n")}` },
    ],
    output_config: { format: zodOutputFormat(Schema) },
  });
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    console.error(`${file}: no output`);
    continue;
  }
  const parsed = Schema.parse(JSON.parse(text.text));
  const byId = new Map(parsed.spots.map((s) => [s.id, s]));

  const changes: string[] = [];
  const kept = [];
  for (const spot of trip.spots) {
    const verdict = byId.get(spot.id);
    if (!verdict) {
      kept.push(spot);
      continue;
    }
    if (verdict.drop) {
      changes.push(`  DROP  ${spot.name} (${spot.category})`);
      continue;
    }
    if (verdict.category !== spot.category) {
      changes.push(`  ${spot.category} → ${verdict.category}  ${spot.name} — ${verdict.reason}`);
      spot.category = verdict.category;
    }
    kept.push(spot);
  }
  trip.spots = kept;

  const otherPct = Math.round(
    (trip.spots.filter((s: { category: string }) => s.category === "other").length /
      Math.max(1, trip.spots.length)) * 100
  );
  console.log(`\n${trip.name} (${file}) — ${changes.length} change(s), "other" now ${otherPct}%`);
  console.log(changes.join("\n") || "  (nothing to change)");

  if (WRITE && changes.length > 0) {
    fs.writeFileSync(full, `${JSON.stringify(trip, null, 2)}\n`);
    console.log(`  ✎ written`);
  }
}

if (!WRITE) console.log("\nReport only. Re-run with --write to apply.");
