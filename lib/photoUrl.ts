/**
 * Client-safe URL builder for the spot-photo proxy (/api/photo).
 *
 * Google Places photo URLs (lh3.googleusercontent.com) expire, so we never
 * render a stored one directly — instead we point <img> at this route, keyed by
 * the durable placeId + photo index. The server resolves a fresh URL per
 * request and the edge caches the bytes. No youtubei.js / server imports, so it
 * stays out of the browser bundle's heavy paths.
 */
import type { Spot } from "./types";

export function googlePhotoProxy(placeId: string, index = 0): string {
  return `/api/photo?place=${encodeURIComponent(placeId)}&i=${index}`;
}

export function spotPhotoUrl(spot: Spot): string | null {
  // Wikimedia photo when we found one; otherwise a frame from the first
  // creator's video — there is always something to show
  return (
    spot.photo?.url ??
    (spot.mentions[0]
      ? `https://i.ytimg.com/vi/${spot.mentions[0].videoId}/hqdefault.jpg`
      : null)
  );
}

/** One stable cover photo for a spot (Google photos go through the proxy —
 *  stored Google URLs expire). */
export function spotCoverUrl(spot: Spot): string | null {
  const isGoogle =
    Boolean(spot.placeId) &&
    (spot.photo?.source === "google" ||
      (spot.photos?.some((p) => p.source === "google") ?? false) ||
      (spot.morePhotoNames?.length ?? 0) > 0);
  return isGoogle ? googlePhotoProxy(spot.placeId!, 0) : spotPhotoUrl(spot);
}
