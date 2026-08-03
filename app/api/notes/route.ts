import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { getCachedVideo } from "@/lib/videoCache";
import { BriefingNote } from "@/lib/types";

export const runtime = "nodejs";
// Blob reads only — nothing here waits on YouTube or a model.
export const maxDuration = 60;

const MAX_VIDEOS = 40;

/**
 * Destination notes for videos that have ALREADY been read, straight from the
 * cross-trip cache.
 *
 * Exists because of an ordering problem the briefing shipped with: notes are
 * harvested during extraction, so a trip built before that existed has none
 * and no way to ever grow any — the transcripts are not re-read. Its videos,
 * though, have almost always been re-processed since (VIDEO_CACHE_VERSION 3
 * invalidated every v2 entry), so the notes usually already exist server-side
 * and just never reached that trip.
 *
 * CACHE-ONLY, and that is the whole point: a miss returns nothing rather than
 * falling through to `processVideo`. A backfill can therefore never trigger a
 * transcript fetch or a model call, which is what makes it safe to attempt
 * from the trip page without asking anyone first.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!rateLimit(req, "notes", 60, user?.id)) return rateLimited();

  const body = await req.json().catch(() => ({}));
  const videoIds: string[] = Array.isArray(body.videoIds)
    ? body.videoIds
        .filter((v: unknown): v is string => typeof v === "string")
        .filter((v: string) => /^[\w-]{11}$/.test(v))
        .slice(0, MAX_VIDEOS)
    : [];
  if (videoIds.length === 0) {
    return NextResponse.json({ notes: [], hits: 0 });
  }

  const cached = await Promise.all(
    videoIds.map((id) => getCachedVideo(id).catch(() => null))
  );

  const notes: BriefingNote[] = [];
  let hits = 0;
  for (const entry of cached) {
    if (!entry) continue;
    hits++;
    if (entry.notes?.length) notes.push(...entry.notes);
  }
  return NextResponse.json({ notes, hits });
}
