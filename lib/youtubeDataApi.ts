/**
 * Official YouTube Data API v3 discovery.
 *
 * Search + metadata is the ONE part of the pipeline Google supports officially,
 * and googleapis.com is not behind the bot check that blocks InnerTube from
 * datacenter IPs — so with a (free) API key, discovery is reliable on Vercel
 * without any proxy. Transcripts still have no official API for arbitrary
 * videos, so those keep going through InnerTube (see lib/youtube.ts).
 *
 * Enable by setting YOUTUBE_API_KEY. Unset, searchVideos() falls back to the
 * keyless InnerTube search.
 *
 * Quota note: search.list costs 100 units against the default 10,000/day, so
 * ~100 searches/day (a discover run issues 4-6). Plenty for a handful of users;
 * raise the quota in Google Cloud if it ever bites.
 */
import type { SearchCandidate } from "./youtube";

export function hasDataApiKey(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

/** ISO-8601 duration ("PT1H2M30S") -> seconds. */
function parseISODuration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

/** Match InnerTube's compact view strings ("1.2M views") for the curation prompt. */
function formatViews(count: string | undefined): string {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K views`;
  return `${n} views`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function searchVideosOfficial(query: string): Promise<SearchCandidate[]> {
  const key = process.env.YOUTUBE_API_KEY!;

  // Step 1: search.list -> video ids (snippet has no duration/stats, so we
  // hydrate in step 2 to fill the fields curation ranks on).
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("maxResults", "25");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("key", key);

  const sres = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
  if (!sres.ok) {
    throw new Error(`YouTube Data API search failed: ${sres.status} ${await sres.text()}`);
  }
  const sdata = (await sres.json()) as any;
  const ids: string[] = (sdata.items ?? [])
    .map((i: any) => i.id?.videoId)
    .filter((id: unknown): id is string => typeof id === "string" && /^[\w-]{11}$/.test(id));
  if (ids.length === 0) return [];

  // Step 2: videos.list -> duration, view count, channel (1 unit for the batch).
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,contentDetails,statistics");
  videosUrl.searchParams.set("id", ids.join(","));
  videosUrl.searchParams.set("key", key);

  const vres = await fetch(videosUrl, { signal: AbortSignal.timeout(10000) });
  if (!vres.ok) {
    throw new Error(`YouTube Data API videos failed: ${vres.status} ${await vres.text()}`);
  }
  const vdata = (await vres.json()) as any;

  const out: SearchCandidate[] = [];
  for (const v of vdata.items ?? []) {
    const id = v.id;
    if (typeof id !== "string" || !/^[\w-]{11}$/.test(id)) continue;
    out.push({
      id,
      title: v.snippet?.title ?? "",
      channelName: v.snippet?.channelTitle ?? "",
      durationSec: parseISODuration(v.contentDetails?.duration ?? ""),
      views: formatViews(v.statistics?.viewCount),
      // ISO timestamp -> YYYY-MM-DD; curation only needs it to gauge recency.
      published: typeof v.snippet?.publishedAt === "string" ? v.snippet.publishedAt.slice(0, 10) : "",
    });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
