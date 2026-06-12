/**
 * One-off repair for trips whose spots were geocoded with a poisoned query
 * (trip-level destination from the wrong video) — re-resolves suspect spots
 * against Google Places with the trip's broad destination.
 *
 * Suspects:
 *  - placeId null / geocodeSource not "google" (lookup missed → pin stranded
 *    on the LLM's rough coords, wiki photo, dead Maps link)
 *  - two differently-named spots sharing one placeId (fuzzy false match —
 *    at most one of them is the real place)
 *
 * Usage: npx tsx scripts/repair-geocode.mts <tripId> [--dry-run]
 */
import fs from "fs";
import path from "path";

const envFile = path.join(process.cwd(), ".env.local");
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { googleFindPlace, googlePhotoUrl } = await import("../lib/google");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tripId = args.find((a) => !a.startsWith("--"));
if (!tripId) {
  console.error("Usage: npx tsx scripts/repair-geocode.mts <tripId> [--dry-run]");
  process.exit(1);
}

const tripPath = path.join("data", "trips", `${tripId}.json`);
const trip = JSON.parse(fs.readFileSync(tripPath, "utf8"));

const destName: string =
  trip.query?.resolvedDestination ?? trip.destination?.name ?? "";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

// placeIds claimed by more than one distinctly-named spot
const byPlace = new Map<string, Set<string>>();
for (const s of trip.spots) {
  if (typeof s.placeId === "string") {
    if (!byPlace.has(s.placeId)) byPlace.set(s.placeId, new Set());
    byPlace.get(s.placeId)!.add(norm(s.name));
  }
}
const dupIds = new Set(
  [...byPlace.entries()].filter(([, names]) => names.size > 1).map(([id]) => id)
);

const suspects = trip.spots.filter(
  (s: any) =>
    s.placeId == null ||
    s.geocodeSource !== "google" ||
    dupIds.has(s.placeId)
);

console.log(
  `Trip "${trip.name}" — ${trip.spots.length} spots, ${suspects.length} suspects (dest suffix: "${destName}")\n`
);

let fixed = 0;
const leftovers: string[] = [];

for (const spot of suspects) {
  const query = destName ? `${spot.name}, ${destName}` : spot.name;
  let place;
  try {
    place = await googleFindPlace(query, spot.lat, spot.lng);
  } catch (err) {
    console.warn(`  !! "${spot.name}" lookup failed:`, err instanceof Error ? err.message : err);
    leftovers.push(spot.name);
    continue;
  }

  if (!place) {
    console.log(`  -- "${spot.name}" — still no match, keeping (${spot.lat}, ${spot.lng})`);
    leftovers.push(spot.name);
    continue;
  }
  if (place.id === spot.placeId) {
    console.log(`  == "${spot.name}" — Google still says the same place, keeping`);
    leftovers.push(`${spot.name} (duplicate placeId)`);
    continue;
  }

  console.log(
    `  FIX "${spot.name}": (${spot.lat.toFixed(4)}, ${spot.lng.toFixed(4)}) [${spot.geocodeSource}] -> (${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}) [google]`
  );
  fixed++;
  if (dryRun) continue;

  spot.lat = place.lat;
  spot.lng = place.lng;
  spot.placeId = place.id;
  spot.geocodeSource = "google";
  const names = place.photoNames.slice(0, 5);
  const coverUrl = names[0] ? await googlePhotoUrl(names[0]).catch(() => null) : null;
  spot.photos = coverUrl ? [{ url: coverUrl, source: "google" }] : [];
  spot.morePhotoNames = names.slice(1);
  if (coverUrl) spot.photo = { url: coverUrl, source: "google" };
  fs.writeFileSync(tripPath, JSON.stringify(trip, null, 2));
}

console.log(
  `\n${dryRun ? "[dry-run] would fix" : "Fixed"} ${fixed}/${suspects.length} suspects.`
);
if (leftovers.length) {
  console.log(`Unresolved (kept as-is):\n  - ${leftovers.join("\n  - ")}`);
}
