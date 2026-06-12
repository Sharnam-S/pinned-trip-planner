import { NextRequest, NextResponse } from "next/server";
import { resolvePhotoSet } from "@/lib/pipeline";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Lazily resolves a spot's remaining carousel photos (first swipe on a tile).
 * The browser passes the Google photo resource names it stored at creation
 * time and keeps the resulting URLs — unswiped cards never bill the API.
 */
export async function POST(req: NextRequest) {
  if (!rateLimit(req, "photos", 400)) return rateLimited();

  const body = await req.json();
  const names: string[] = Array.isArray(body.names)
    ? body.names
        .filter((n: unknown) => typeof n === "string")
        .filter((n: string) => /^places\/[^/]+\/photos\//.test(n))
        .slice(0, 5)
    : [];
  if (names.length === 0) return NextResponse.json({ urls: [] });

  const photos = await resolvePhotoSet(names);
  return NextResponse.json({ urls: photos.map((p) => p.url) });
}
