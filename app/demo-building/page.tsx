"use client";

/**
 * Dev-only preview of the trip-building screen with dummy data — no API keys
 * or real pipeline needed. Auto-plays the build (curating → videos appearing →
 * transcripts being read), with buttons to jump straight to any state.
 * Safe to delete before shipping.
 */

import { useEffect, useRef, useState } from "react";
import BuildingScreen from "@/components/BuildingScreen";
import { Trip, TripVideo } from "@/lib/types";

const LINEUP: [string, string, string][] = [
  ["dQw4w9WgXcQ", "10 Best Hikes in Switzerland — Part 1", "Markus Rosehill"],
  ["9bZkp7q19f0", "9 Best Hikes in Switzerland YOU CAN'T MISS!", "Made to Explore"],
  ["kJQP7kiw5Fk", "Running One of the Most Scenic Races in the World", "Jeff Pelletier"],
  ["RgKAFK5djSk", "How to Spend 14 Days Hiking in SWITZERLAND", "Made to Explore"],
  ["OPf0YbXqDm0", "We Didn't Expect Switzerland to be Like THIS", "Jaychel"],
  ["fJ9rUzIMcZQ", "Switzerland: The Best Hikes Near Interlaken", "RyanTravels"],
  ["e-ORhEE9VVg", "5 DAYS IN THE ALPS | hiking & trail running", "Lucy Georgia"],
  ["YQHsXMglC9A", "Stoos Ridge Hike + 8 Things to do in Switzerland", "Aplins in the Alps"],
];

function video(
  [id, title, channelName]: [string, string, string],
  status: TripVideo["status"],
  spotCount?: number
): TripVideo {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    channelName,
    channelAvatar: "",
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    status,
    ...(spotCount != null ? { spotCount } : {}),
  };
}

function baseTrip(): Trip {
  return {
    id: "demo-building",
    name: "Switzerland",
    destination: null,
    createdAt: new Date().toISOString(),
    status: "processing",
    progress: "Planning YouTube searches…",
    videos: [],
    spots: [],
    query: { destination: "Switzerland", interests: "hiking" },
  };
}

// Frames of the simulated build: [progress message, videos-done count, delay ms]
// -1 done-count = still curating (no videos yet).
const FRAMES: [string, number, number][] = [
  ["Planning YouTube searches…", -1, 4000],
  ["Picked 8 videos — reading transcripts…", 0, 2500],
  ["Reading 8 transcripts in parallel — extracting spots with Claude…", 0, 4000],
  ['Read 1/8 — "10 Best Hikes in Switzerland" added 6 new spots.', 1, 3500],
  ['Read 2/8 — "9 Best Hikes in Switzerland YOU CAN\'T MISS!" added 4 new spots.', 2, 3500],
  ['Read 3/8 — "Running One of the Most Scenic Races" added 3 new spots.', 3, 3500],
  ['Read 4/8 — "How to Spend 14 Days Hiking" added 5 new spots.', 4, 3500],
  ['Read 5/8 — "We Didn\'t Expect Switzerland to be Like THIS" added 2 new spots.', 5, 3500],
  ['Read 6/8 — "The Best Hikes Near Interlaken" added 4 new spots.', 6, 3500],
];

const SPOTS_PER_VIDEO = [6, 4, 3, 5, 2, 4, 3, 2];

function tripAtFrame(frame: number): Trip {
  const t = baseTrip();
  const [progress, done] = FRAMES[frame];
  t.progress = progress;
  if (done >= 0) {
    t.videos = LINEUP.map((v, i) =>
      i < done ? video(v, "done", SPOTS_PER_VIDEO[i]) : video(v, "processing")
    );
  }
  return t;
}

export default function DemoBuilding() {
  const [frame, setFrame] = useState(0);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!playing || error) return;
    timer.current = setTimeout(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAMES[frame][2]);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [frame, playing, error]);

  const trip = error
    ? { ...baseTrip(), status: "error" as const, progress: "All videos failed to process." }
    : tripAtFrame(frame);

  const jump = (f: number) => {
    setError(false);
    setFrame(f);
  };

  return (
    <>
      <BuildingScreen trip={trip} />
      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
          display: "flex",
          gap: 8,
          background: "rgba(23, 35, 46, 0.85)",
          backdropFilter: "blur(8px)",
          borderRadius: 999,
          padding: "8px 12px",
          color: "white",
          fontSize: 12.5,
          fontWeight: 600,
          alignItems: "center",
        }}
      >
        <span style={{ opacity: 0.7, marginRight: 4 }}>Demo:</span>
        <button style={pill} onClick={() => jump(0)}>Curating</button>
        <button style={pill} onClick={() => jump(3)}>Watching</button>
        <button style={pill} onClick={() => setError(true)}>Error</button>
        <button style={pill} onClick={() => setPlaying((p) => !p)}>
          {playing && !error ? "Pause" : "Play"}
        </button>
      </div>
    </>
  );
}

const pill: React.CSSProperties = {
  background: "rgba(255,255,255,0.14)",
  color: "white",
  border: "none",
  borderRadius: 999,
  padding: "6px 12px",
  font: "inherit",
  cursor: "pointer",
};
