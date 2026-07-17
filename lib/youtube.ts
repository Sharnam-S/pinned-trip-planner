import { Innertube } from "youtubei.js";
import { ytFetch, proxyEnabled } from "./proxyFetch";
import { hasDataApiKey, searchVideosOfficial } from "./youtubeDataApi";

let ytPromise: Promise<Innertube> | null = null;

/**
 * From datacenter IPs (Vercel), YouTube bot-checks /player requests unless
 * the session carries a BotGuard proof-of-origin token. Mint one per process
 * (the documented BgUtils recipe: visitor data -> challenge -> run the
 * interpreter VM -> generate token). Falls back to a plain session — which
 * is all that's needed locally — if any minting step fails.
 */
async function createClient(): Promise<Innertube> {
  console.log(
    `[youtube] InnerTube client init — proxy ${proxyEnabled ? "ON" : "off"}, ` +
      `search via ${hasDataApiKey() ? "Data API" : "InnerTube"}`
  );
  try {
    const base = await Innertube.create({ retrieve_player: false, fetch: ytFetch });
    const visitorData = base.session.context.client.visitorData;
    if (!visitorData) throw new Error("no visitor data");

    const { BG } = await import("bgutils-js");
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM();
    // BotGuard's VM needs window/document; expose them only while minting so
    // nothing else (SSR code branching on `typeof window`) sees a fake browser.
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    try {
      const bgConfig = {
        fetch: (input: string | URL | Request, init?: RequestInit) => ytFetch(input, init),
        globalObj: globalThis,
        identifier: visitorData,
        requestKey: "O43z0dpjhgX20SCx4KAo",
      };
      const challenge = await BG.Challenge.create(bgConfig);
      if (!challenge) throw new Error("no challenge");
      const script =
        challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
      if (!script) throw new Error("no interpreter script");
      new Function(script)();
      const poToken = await BG.PoToken.generate({
        program: challenge.program,
        globalName: challenge.globalName,
        bgConfig,
      });
      return await Innertube.create({
        po_token: poToken.poToken,
        visitor_data: visitorData,
        generate_session_locally: true,
        fetch: ytFetch,
      });
    } finally {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
    }
  } catch (err) {
    console.warn(
      "[youtube] po_token minting failed, using plain session:",
      err instanceof Error ? err.message : err
    );
    return Innertube.create({ generate_session_locally: true, fetch: ytFetch });
  }
}

function getClient(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = createClient();
  }
  return ytPromise;
}

// parseVideoId lives in lib/links.ts — client-safe, no InnerTube import

export interface SearchCandidate {
  id: string;
  title: string;
  channelName: string;
  durationSec: number;
  views: string;
  published: string;
}

/**
 * YouTube search. Prefers the official Data API v3 when YOUTUBE_API_KEY is set
 * (reliable from datacenter IPs — googleapis.com isn't bot-checked); otherwise
 * falls back to the keyless InnerTube search (same client we fetch transcripts
 * with, and the only option locally without a key).
 */
export async function searchVideos(query: string): Promise<SearchCandidate[]> {
  if (hasDataApiKey()) {
    return searchVideosOfficial(query);
  }
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

// YouTube bot-checks the default WEB client from datacenter IPs (Vercel):
// getInfo "succeeds" but comes back hollow — no title, no caption tracks.
// Alternate clients usually pass, so walk the list until one returns
// captions. Locally WEB wins on the first try and nothing changes.
// Only these clients expose caption tracks (TV variants don't).
const INFO_CLIENTS = ["WEB", "MWEB", "ANDROID", "IOS"] as const;

async function getInfoWithCaptions(yt: Innertube, videoId: string) {
  let best: Awaited<ReturnType<Innertube["getInfo"]>> | null = null;
  let hollow: Awaited<ReturnType<Innertube["getInfo"]>> | null = null;
  const attempts: string[] = [];
  for (const client of INFO_CLIENTS) {
    try {
      const info = await yt.getInfo(videoId, { client });
      const hasTitle = Boolean(info.basic_info.title);
      const hasTracks = (info.captions?.caption_tracks ?? []).length > 0;
      attempts.push(
        `${client}=${hasTitle ? "title" : "-"}/${hasTracks ? "tracks" : "-"}/${info.playability_status?.status ?? "?"}`
      );
      if (hasTitle && hasTracks) return info;
      if (hasTitle) {
        if (!best) best = info; // real video, just no captions on this client
      } else if (!hollow) {
        // bot-checked husk: /player was refused, but the /next data inside
        // may still carry the transcript engagement panel — keep it
        hollow = info;
      }
    } catch (err) {
      attempts.push(
        `${client}=ERR(${(err instanceof Error ? err.message : String(err)).slice(0, 60)})`
      );
    }
  }
  // degraded result — leave a trail in the server logs for diagnosis
  console.warn(`[youtube] info degraded for ${videoId}:`, attempts.join(" | "));
  return best ?? hollow;
}

/** Title/channel/thumbnail without touching /player — oEmbed is public and
 *  isn't behind the bot check that blocks video info from server IPs. */
async function fetchOEmbed(videoId: string) {
  try {
    const res = await ytFetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title ?? "",
      channelName: data.author_name ?? "",
      thumbnail: data.thumbnail_url ?? "",
    };
  } catch {
    return null;
  }
}

export async function fetchVideoData(videoId: string): Promise<VideoData> {
  const yt = await getClient();
  const info = await getInfoWithCaptions(yt, videoId);
  if (!info) {
    throw new Error(
      "YouTube refused the request for this video (bot check) — try again in a bit."
    );
  }

  const botChecked = !info.basic_info.title;
  let title = info.basic_info.title ?? "";
  let channelName = info.basic_info.author ?? "";
  let thumbnail = info.basic_info.thumbnail?.[0]?.url ?? "";
  if (botChecked) {
    const oe = await fetchOEmbed(videoId);
    if (oe) {
      title = oe.title;
      channelName = channelName || oe.channelName;
      thumbnail = thumbnail || oe.thumbnail;
    }
  }
  title = title || "Untitled video";
  channelName = channelName || "Unknown creator";

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
      const res = await ytFetch(`${track.base_url}&fmt=json3`, {
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
    } catch (err) {
      console.warn(
        `[youtube] getTranscript fallback failed for ${videoId}:`,
        err instanceof Error ? err.message : err
      );
      throw new Error(
        botChecked
          ? "YouTube refused the request for this video (bot check) — try again in a bit."
          : `No transcript available for "${title}". The video needs captions (auto-generated is fine).`
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
