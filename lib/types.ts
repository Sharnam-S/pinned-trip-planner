export type SpotCategory =
  | "food"
  | "nature"
  | "beach"
  | "temple"
  | "activity"
  | "viewpoint"
  | "stay"
  | "shopping"
  | "town"
  | "other";

export interface Mention {
  videoId: string;
  videoTitle: string;
  channelName: string;
  channelAvatar: string;
  timestampSec: number;
  quote: string;
}

export interface SpotPhotoRef {
  url: string;
  source: "wikimedia";
}

export interface Spot {
  id: string;
  name: string;
  category: SpotCategory;
  description: string;
  lat: number;
  lng: number;
  geocodeSource: "nominatim" | "llm";
  mentions: Mention[];
  /** Practical tips/warnings creators mentioned (pickpockets, timings, tickets…). */
  thingsToKnow?: string[];
  /** Wikimedia photo; null = lookup tried and missed; undefined = not looked up yet. */
  photo?: SpotPhotoRef | null;
}

export type VideoStatus = "pending" | "processing" | "done" | "error";

export interface TripVideo {
  id: string; // YouTube video id
  url: string;
  title: string;
  channelName: string;
  channelAvatar: string;
  thumbnail: string;
  status: VideoStatus;
  error?: string;
  spotCount?: number;
}

export interface Destination {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
}

export type TripStatus = "processing" | "ready" | "error";

export interface Trip {
  id: string;
  name: string;
  destination: Destination | null;
  createdAt: string;
  status: TripStatus;
  progress: string;
  videos: TripVideo[];
  spots: Spot[];
}
