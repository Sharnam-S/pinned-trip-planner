/**
 * Client-safe URL builder for the spot-photo proxy (/api/photo).
 *
 * Google Places photo URLs (lh3.googleusercontent.com) expire, so we never
 * render a stored one directly — instead we point <img> at this route, keyed by
 * the durable placeId + photo index. The server resolves a fresh URL per
 * request and the edge caches the bytes. No youtubei.js / server imports, so it
 * stays out of the browser bundle's heavy paths.
 */
export function googlePhotoProxy(placeId: string, index = 0): string {
  return `/api/photo?place=${encodeURIComponent(placeId)}&i=${index}`;
}
