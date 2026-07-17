/**
 * Cross-trip cache of processed videos, backed by Vercel Blob (the same shared
 * store trips publish to). Reading and resolving a video — transcript fetch via
 * the residential proxy, Claude extraction, per-spot Google Places lookups — is
 * slow and billed. The result is trip-independent, so we cache it by YouTube id
 * once: if your friend's Sri Lanka trip already processed a video, your trip
 * reuses it for free.
 *
 * Server-side only — the blob token must never reach the browser, so this is
 * imported by the pipeline, never by client code.
 */
import { list, put } from "@vercel/blob";
import { CachedVideo } from "./merge";

const PREFIX = "video-cache/";
const pathFor = (videoId: string) => `${PREFIX}${videoId}.json`;

/** Bump when CachedVideo's shape or the resolution logic changes materially. */
export const VIDEO_CACHE_VERSION = 1;

function enabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** A previously processed video, or null on miss / stale version / any error. */
export async function getCachedVideo(videoId: string): Promise<CachedVideo | null> {
  if (!enabled()) return null;
  try {
    const { blobs } = await list({ prefix: pathFor(videoId), limit: 1 });
    const hit = blobs.find((b) => b.pathname === pathFor(videoId));
    if (!hit) return null;
    const res = await fetch(hit.url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as CachedVideo;
    // Old-shape entries are treated as a miss so the caller re-processes and
    // overwrites — cheaper than migrating and never serves a stale shape.
    if (data.version !== VIDEO_CACHE_VERSION) return null;
    return data;
  } catch (err) {
    console.warn("[videoCache] read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Stores a processed video for reuse. Best-effort — callers must not fail on a
 *  write error; the worst case is the next trip re-processes it. */
export async function putCachedVideo(data: CachedVideo): Promise<void> {
  if (!enabled()) return;
  await put(pathFor(data.video.id), JSON.stringify(data), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true, // re-processing a video (e.g. version bump) supersedes
    cacheControlMaxAge: 0, // always serve the latest on the next read
  });
}
