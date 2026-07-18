import { SpotCategory } from "./types";

export const CATEGORY_EMOJI: Record<SpotCategory, string> = {
  food: "🍜",
  nightlife: "🍸",
  nature: "🌿",
  beach: "🏖️",
  viewpoint: "🌄",
  landmark: "🏛️",
  museum: "🖼️",
  activity: "🪂",
  wellness: "🧖",
  market: "🧺",
  shopping: "🛍️",
  stay: "🏡",
  town: "🏘️",
  other: "📍",
};

export function youtubeLink(videoId: string, timestampSec: number) {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, timestampSec)}s`;
}

export function formatTimestamp(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
