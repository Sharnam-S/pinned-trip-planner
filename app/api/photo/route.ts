import { NextRequest, NextResponse } from "next/server";
import { googlePlacePhotoNames, googlePhotoUrl, isGoogleEnabled } from "@/lib/google";

export const runtime = "nodejs";

/**
 * Spot-photo proxy. Google Places photo URIs expire, so we never store the
 * resolved lh3.googleusercontent.com URL — we resolve a fresh one here from the
 * durable placeId + index, fetch the bytes, and hand them back with a long
 * cache so Vercel's edge serves repeats for free (Google is billed only on a
 * cache miss). The API key never leaves the server.
 */

// placeId -> photo resource names. Names are stable, so caching them within a
// warm instance saves the Place Details call on repeat requests for the same
// place (e.g. every photo index of one spot).
const nameCache = new Map<string, string[]>();

async function photoNames(placeId: string): Promise<string[]> {
  const cached = nameCache.get(placeId);
  if (cached) return cached;
  const names = await googlePlacePhotoNames(placeId);
  nameCache.set(placeId, names);
  return names;
}

export async function GET(req: NextRequest) {
  if (!isGoogleEnabled()) return new NextResponse(null, { status: 404 });

  const place = req.nextUrl.searchParams.get("place");
  const rawIndex = Number(req.nextUrl.searchParams.get("i") ?? "0");
  const index = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0;
  // Google place ids are URL-safe tokens (e.g. ChIJ…); reject anything else.
  if (!place || !/^[\w-]+$/.test(place)) return new NextResponse(null, { status: 400 });

  try {
    const names = await photoNames(place);
    const name = names[index];
    if (!name) return new NextResponse(null, { status: 404 });

    const uri = await googlePhotoUrl(name);
    if (!uri) return new NextResponse(null, { status: 404 });

    const img = await fetch(uri, { signal: AbortSignal.timeout(10000) });
    if (!img.ok || !img.body) return new NextResponse(null, { status: 502 });

    return new NextResponse(img.body, {
      status: 200,
      headers: {
        "Content-Type": img.headers.get("content-type") ?? "image/jpeg",
        // Cache hard: a (placeId, index) always maps to the same photo. The
        // fresh lh3 URL rots, but our route re-resolves it, so callers cache us.
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      },
    });
  } catch {
    // Expired/removed place, quota, or network — let <img> fall back.
    return new NextResponse(null, { status: 502 });
  }
}
