/**
 * The country flag for a destination, read off its name.
 *
 * Trips only ever store place *names* — the geocoder hands back coordinates,
 * not country codes — so "Arugam Bay, Sri Lanka" is what we have to work with.
 * Last comma segment first, since a place name ends with its country far more
 * often than it starts with one.
 *
 * The name -> code index comes from Intl.DisplayNames instead of a hand-kept
 * table of 250 countries, plus aliases for what people actually type. No flag
 * unless we're sure: an unrecognised name gets none rather than a wrong one.
 *
 * Caveat: regional-indicator pairs render as two letters on Windows Chrome,
 * which ships no flag glyphs. That degrades to "LK Sri Lanka" — plain, not
 * broken — and is why the flag is never the only thing naming a place.
 */
import type { Trip } from "./types";

// Codes Intl still resolves that aren't flags: withdrawn ISO entries and
// groupings. "UK" matters most — it's a deprecated alias for GB, and 🇺🇰 is not
// a flag, it's the letters UK.
const NOT_FLAGS = new Set([
  "AN", "BU", "CS", "DD", "EA", "EZ", "FX", "IC", "NT", "QO", "QU", "SU",
  "TP", "UK", "XA", "XB", "YD", "YU", "ZR", "ZZ",
]);

// What people type that Intl's canonical names don't cover.
const ALIASES: Record<string, string> = {
  usa: "US",
  america: "US",
  "united states of america": "US",
  uk: "GB",
  britain: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  turkey: "TR",
  uae: "AE",
  "united arab emirates": "AE",
  holland: "NL",
  "czech republic": "CZ",
  burma: "MM",
  "ivory coast": "CI",
  "cape verde": "CV",
  macedonia: "MK",
  swaziland: "SZ",
  "east timor": "TL",
  vatican: "VA",
  "dr congo": "CD",
  "democratic republic of the congo": "CD",
};

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ");
}

let index: Map<string, string> | null = null;

function nameIndex(): Map<string, string> {
  if (index) return index;
  const map = new Map<string, string>();
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_FLAGS.has(code)) continue;
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      // Intl echoes the code back for regions it doesn't know.
      if (!name || name === code) continue;
      const key = normalize(name);
      if (!map.has(key)) map.set(key, code);
      // "Hong Kong SAR China" and "Myanmar (Burma)" are also typed short.
      const short = key.replace(/ sar china$/, "").replace(/ \(.*\)$/, "").trim();
      if (short && short !== key && !map.has(short)) map.set(short, code);
    }
  }
  for (const [name, code] of Object.entries(ALIASES)) map.set(normalize(name), code);
  index = map;
  return map;
}

function flagEmoji(code: string): string {
  // Regional indicator symbols: A = U+1F1E6.
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

/** Flag for a place name like "Arugam Bay, Sri Lanka", or null if no country
 *  in it is recognised. */
export function countryFlag(place?: string | null): string | null {
  if (!place) return null;
  const map = nameIndex();
  const segments = place.split(",").map(normalize).filter(Boolean).reverse();
  for (const segment of segments) {
    const code = map.get(segment);
    if (code) return flagEmoji(code);
  }
  return null;
}

/** The trip's flag, from the most precise name it has: the resolved
 *  destination beats the raw query, which beats the trip's display name. */
export function tripFlag(trip: Trip): string | null {
  const candidates = [
    trip.destination?.name,
    trip.query?.resolvedDestination,
    trip.query?.destination,
    trip.name,
  ];
  for (const candidate of candidates) {
    const flag = countryFlag(candidate);
    if (flag) return flag;
  }
  return null;
}
