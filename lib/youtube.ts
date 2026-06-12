import { Innertube } from "youtubei.js";

let ytPromise: Promise<Innertube> | null = null;

function getClient(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = Innertube.create({ generate_session_locally: true });
  }
  return ytPromise;
}

export function parseVideoId(url: string): string | null {
  const trimmed = url.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // shorts or embed URLs
      const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    return null;
  }
  return null;
}

export interface SearchCandidate {
  id: string;
  title: string;
  channelName: string;
  durationSec: number;
  views: string;
  published: string;
}

/** Keyless YouTube search via InnerTube — same client we fetch transcripts with. */
export async function searchVideos(query: string): Promise<SearchCandidate[]> {
  const yt = await getClient();
  const res = await yt.search(query, { type: "video" });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const items: any[] = (res as any).videos ?? (res as any).results ?? [];
  const out: SearchCandidate[] = [];
  for (const v of items) {
    if (v.type !== "Video") continue;
    const id = v.video_id ?? v.id;
    if (typeof id !== "string" || !/^[\w-]{11}$/.test(id)) continue;
    out.push({
      id,
      title: v.title?.text ?? String(v.title ?? ""),
      channelName: v.author?.name ?? "",
      durationSec: Number(v.duration?.seconds ?? 0),
      views: v.view_count?.text ?? v.short_view_count?.text ?? "",
      published: v.published?.text ?? "",
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return out;
}

export interface VideoData {
  id: string;
  title: string;
  channelName: string;
  channelAvatar: string;
  thumbnail: string;
  transcript: { text: string; startSec: number }[];
}

export async function fetchVideoData(videoId: string): Promise<VideoData> {
  const yt = await getClient();
  const info = await yt.getInfo(videoId);

  const title = info.basic_info.title ?? "Untitled video";
  const channelName = info.basic_info.author ?? "Unknown creator";
  const thumbnail = info.basic_info.thumbnail?.[0]?.url ?? "";

  let channelAvatar = "";
  try {
    const channelId = info.basic_info.channel_id;
    if (channelId) {
      const channel = await yt.getChannel(channelId);
      const avatars = channel.metadata?.avatar;
      if (avatars && avatars.length > 0) channelAvatar = avatars[0].url;
    }
  } catch {
    // avatar is cosmetic; continue without it
  }

  // Primary: fetch the caption track directly (json3 timedtext). This is more
  // reliable than InnerTube's get_transcript endpoint, which intermittently 400s.
  let transcript: { text: string; startSec: number }[] = [];
  const tracks = info.captions?.caption_tracks ?? [];
  if (tracks.length > 0) {
    const track =
      tracks.find((t) => t.language_code?.startsWith("en")) ?? tracks[0];
    try {
      const res = await fetch(`${track.base_url}&fmt=json3`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          events?: { tStartMs?: number; segs?: { utf8?: string }[] }[];
        };
        transcript = (data.events ?? [])
          .filter((e) => e.segs)
          .map((e) => ({
            text: (e.segs ?? [])
              .map((s) => s.utf8 ?? "")
              .join("")
              .replace(/\s+/g, " ")
              .trim(),
            startSec: Math.floor((e.tStartMs ?? 0) / 1000),
          }))
          .filter((s) => s.text.length > 0 && s.text !== "[Music]");
      }
    } catch {
      // fall through to getTranscript()
    }
  }

  if (transcript.length === 0) {
    try {
      const transcriptInfo = await info.getTranscript();
      const segments =
        transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
      transcript = segments
        .map((seg) => ({
          text: (seg.snippet?.text ?? "").toString().trim(),
          startSec: Math.floor(Number(seg.start_ms ?? 0) / 1000),
        }))
        .filter((s) => s.text.length > 0);
    } catch {
      throw new Error(
        `No transcript available for "${title}". The video needs captions (auto-generated is fine).`
      );
    }
  }

  if (transcript.length === 0) {
    throw new Error(`Transcript for "${title}" came back empty.`);
  }

  return { id: videoId, title, channelName, channelAvatar, thumbnail, transcript };
}

/** Render the transcript with timestamps so the model can cite where a spot is mentioned. */
export function transcriptToText(
  transcript: { text: string; startSec: number }[]
): string {
  return transcript.map((s) => `[${s.startSec}] ${s.text}`).join("\n");
}
