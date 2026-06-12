// Spot photo lookup via Wikimedia Commons full-text search — keyless, CORS-free,
// great for landmarks/temples/viewpoints. Obscure warungs and villas will miss;
// the UI falls back to the recommending creator's video thumbnail.

const BAD_TITLE = /\b(map|locator|flag|logo|coat[ _]of[ _]arms|diagram|plan|chart|banner|icon)\b/i;
const GOOD_EXT = /\.(jpe?g|png|webp)$/i;

interface CommonsPage {
  index?: number;
  title?: string;
  imageinfo?: { thumburl?: string; url?: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchCommons(query: string): Promise<string | null> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
    `&gsrsearch=${encodeURIComponent(query)}` +
    "&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=640&format=json&origin=*";
  let res = await fetch(url, {
    headers: { "User-Agent": "youtube-trip-planner/1.0 (local hobby app)" },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429) {
    // Commons throttles bursts — breathe and try once more
    await sleep(3000);
    res = await fetch(url, {
      headers: { "User-Agent": "youtube-trip-planner/1.0 (local hobby app)" },
      signal: AbortSignal.timeout(8000),
    });
  }
  if (!res.ok) {
    // still throttled / 5xx — transient; let the caller retry on a later pass
    throw new Error(`Commons returned ${res.status} for "${query}"`);
  }
  const data = await res.json();
  const pages: CommonsPage[] = Object.values(data?.query?.pages ?? {});
  pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const p of pages) {
    const title = p.title ?? "";
    if (!GOOD_EXT.test(title) || BAD_TITLE.test(title)) continue;
    const ii = p.imageinfo?.[0];
    const thumb = ii?.thumburl || ii?.url;
    if (thumb) return thumb;
  }
  return null;
}

export interface SpotPhoto {
  url: string;
  source: "wikimedia";
}

/**
 * Best-effort photo for a spot. Tries "name + destination" first for
 * disambiguation, then the bare name and any parenthetical alias.
 * Returns null ONLY on a definitive "Commons has nothing usable" — network
 * failures throw so callers can leave the spot un-marked and retry later.
 */
export async function findSpotPhoto(
  name: string,
  destinationName: string | null
): Promise<SpotPhoto | null> {
  const region = destinationName ? destinationName.split(",")[0].trim() : "";
  const alias = name.match(/\(([^)]{3,})\)/)?.[1]?.trim();
  const bare = name.replace(/\s*\([^)]*\)/g, "").trim();
  const names = [...new Set([bare, alias].filter(Boolean))] as string[];
  const queries: string[] = [];
  for (const n of names) {
    if (region && !n.toLowerCase().includes(region.toLowerCase())) queries.push(`${n} ${region}`);
    queries.push(n);
  }
  for (const q of queries) {
    const url = await searchCommons(q);
    if (url) return { url, source: "wikimedia" };
    await sleep(400); // stay under Commons' burst limit
  }
  return null;
}
