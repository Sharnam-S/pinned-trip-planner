/**
 * One-off: fix spots whose transcript-garbled names the geocoder can't
 * recover, identified by hand from the mention quotes.
 * - "Poodle Point"/"pille point" = Pottuvil Point (surf break)
 * - "Jetski Serene"/"Jetway Serve"/"jet wi serve" = Jetwing Surf (resort)
 * - "Mita" = Meewitha Restaurant, Weligama
 * - "Kaa" = Kaa Guest House (Google lists it as Surf Rest by Khanna)
 * - "Coffee specializes" = Integration Coffee (not on Google Maps; pin in town)
 */
import fs from "fs";
import path from "path";

const envFile = path.join(process.cwd(), ".env.local");
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { googlePlacePhotoNames, googlePhotoUrl } = await import("../lib/google");

interface Fix {
  match: string;
  name: string;
  placeId?: string;
  lat: number;
  lng: number;
}

const FIXES: Record<string, Fix[]> = {
  "7703a30b18a0": [
    { match: "Poodle Point", name: "Pottuvil Point", placeId: "ChIJfdWB7_Si5ToRd7r5g1IBLW0", lat: 6.8901011, lng: 81.8429276 },
    { match: "Jetski Serene", name: "Jetwing Surf", placeId: "ChIJy408wR-j5ToRzrrzQt0Spz0", lat: 6.8795811, lng: 81.8434859 },
    { match: "Mita", name: "Meewitha Restaurant", placeId: "ChIJqxV7_0cV4ToRQzAezmDyy0A", lat: 5.973654, lng: 80.4327097 },
    { match: "Kaa", name: "Kaa Guest House", placeId: "ChIJ9YLuQgC95ToRzGEXNAga7_o", lat: 6.8362347, lng: 81.8332715 },
    { match: "Coffee specializes", name: "Integration Coffee", lat: 6.8445, lng: 81.8307 },
  ],
  "321b79dff723": [
    { match: "Poodle Point", name: "Pottuvil Point", placeId: "ChIJfdWB7_Si5ToRd7r5g1IBLW0", lat: 6.8901011, lng: 81.8429276 },
    { match: "Jetway Serve", name: "Jetwing Surf", placeId: "ChIJy408wR-j5ToRzrrzQt0Spz0", lat: 6.8795811, lng: 81.8434859 },
    // placeId pointed at Nami Cafe (false match); keep in-town coords, no link
    { match: "Integration Coffee", name: "Integration Coffee", lat: 6.8458233, lng: 81.8304989 },
  ],
};

for (const [tripId, fixes] of Object.entries(FIXES)) {
  const tripPath = path.join("data", "trips", `${tripId}.json`);
  const trip = JSON.parse(fs.readFileSync(tripPath, "utf8"));
  for (const fix of fixes) {
    const spot = trip.spots.find((s: any) => s.name === fix.match);
    if (!spot) {
      console.log(`${tripId}: "${fix.match}" not found, skipping`);
      continue;
    }
    spot.name = fix.name;
    spot.lat = fix.lat;
    spot.lng = fix.lng;
    if (fix.placeId) {
      spot.placeId = fix.placeId;
      spot.geocodeSource = "google";
      const names = (await googlePlacePhotoNames(fix.placeId).catch(() => [])).slice(0, 5);
      const cover = names[0] ? await googlePhotoUrl(names[0]).catch(() => null) : null;
      spot.photos = cover ? [{ url: cover, source: "google" }] : [];
      spot.morePhotoNames = names.slice(1);
      if (cover) spot.photo = { url: cover, source: "google" };
    } else {
      spot.placeId = null;
      spot.geocodeSource = "llm";
      spot.photos = [];
      spot.morePhotoNames = undefined;
      spot.photo = null; // don't backfill a wrong-place photo
    }
    console.log(`${tripId}: "${fix.match}" -> "${fix.name}" (${fix.lat}, ${fix.lng})`);
  }
  fs.writeFileSync(tripPath, JSON.stringify(trip, null, 2));
}
