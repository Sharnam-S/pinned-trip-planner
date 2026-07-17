/**
 * Browser-side trip builder. The server is stateless compute (search, Claude
 * extraction, geocoding); this module orchestrates the calls and saves every
 * step into localStorage, so the UI can subscribe and render progress live.
 *
 * Runs are per-tab: closing the tab pauses a build, and the trip page resumes
 * it on the next visit (pending videos are picked up where they left off).
 */
import { getLocalTrip, publishTrip, saveLocalTrip } from "./clientStore";
import { applyVideoResult, pendingVideo, VideoResult } from "./merge";
import { Trip } from "./types";

const running = new Set<string>();

export function isRunning(tripId: string) {
  return running.has(tripId);
}

/** Starts (or resumes) building a trip. No-op if already running in this tab. */
export function ensureRunning(tripId: string) {
  if (running.has(tripId)) return;
  running.add(tripId);
  void run(tripId).finally(() => running.delete(tripId));
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Request failed (${res.status})`
    );
  }
  return data as T;
}

function save(trip: Trip) {
  if (!saveLocalTrip(trip)) {
    throw new Error(
      "Your browser storage is full — delete an old trip and try again."
    );
  }
}

async function run(tripId: string) {
  let trip = getLocalTrip(tripId);
  if (!trip) return;

  try {
    // A fresh runner means nothing is actually mid-flight: any video still
    // marked "processing" was orphaned when a prior page load was refreshed or
    // navigated away before its request came back. Re-queue those so they get
    // processed instead of hanging on a spinner forever — otherwise the build
    // ends prematurely as "Done — 0 spots" with videos stuck processing.
    const orphaned = trip.videos.filter((v) => v.status === "processing");
    if (orphaned.length > 0) {
      for (const v of orphaned) v.status = "pending";
      save(trip);
    }

    // Search-mode trip that hasn't found its videos yet
    if (trip.query && trip.videos.length === 0) {
      trip.status = "processing";
      trip.progress = "Planning YouTube searches…";
      save(trip);

      const plan = await post<{
        resolvedDestination: string;
        videos: { id: string; title: string; channelName: string }[];
        bench: string[];
      }>("/api/discover", trip.query);

      trip = getLocalTrip(tripId);
      if (!trip) return;
      trip.query!.resolvedDestination = plan.resolvedDestination;
      trip.name = plan.resolvedDestination;
      trip.videos = plan.videos.map((v) => pendingVideo(v.id, v.title, v.channelName));
      trip.bench = plan.bench;
      trip.progress = `Picked ${trip.videos.length} videos — reading transcripts…`;
      save(trip);
    }

    // Process pending videos, swapping caption-less picks from the bench
    for (let round = 0; round < 4; round++) {
      await processPending(tripId);
      const t = getLocalTrip(tripId);
      if (!t) return;
      const errored = t.videos.filter((v) => v.status === "error");
      if (errored.length === 0 || !t.bench || t.bench.length === 0) break;

      const subs = t.bench.splice(0, errored.length);
      t.videos = t.videos.filter((v) => v.status !== "error");
      t.videos.push(...subs.map((id) => pendingVideo(id)));
      t.progress = `${errored.length} video${errored.length === 1 ? " has" : "s have"} no captions — swapping in replacement${subs.length === 1 ? "" : "s"}…`;
      save(t);
    }

    const finished = getLocalTrip(tripId);
    if (!finished) return;
    const allFailed =
      finished.videos.length > 0 &&
      finished.videos.every((v) => v.status === "error");
    finished.status = allFailed ? "error" : "ready";
    finished.progress = allFailed
      ? "All videos failed to process."
      : `Done — ${finished.spots.length} spots on the map.`;
    save(finished);

    // One shared pool: a finished trip publishes to the shared library so it
    // shows up everywhere (your phone, the deployed site, friends). Best-
    // effort — a publish failure never blocks the local trip.
    if (!allFailed && finished.spots.length > 0) {
      void publishTrip(finished);
    }
  } catch (err) {
    const t = getLocalTrip(tripId);
    if (!t) return;
    t.status = "error";
    t.progress = err instanceof Error ? err.message : String(err);
    saveLocalTrip(t);
  }
}

async function processPending(tripId: string) {
  let trip = getLocalTrip(tripId);
  if (!trip) return;

  for (const ref of trip.videos.filter((v) => v.status === "pending")) {
    trip = getLocalTrip(tripId);
    if (!trip) return;
    const video = trip.videos.find((v) => v.id === ref.id)!;
    video.status = "processing";
    trip.status = "processing";
    trip.progress = video.title
      ? `Reading "${video.title}" — extracting spots with Claude…`
      : "Reading transcript — extracting spots with Claude…";
    save(trip);

    try {
      const result = await post<VideoResult>("/api/process-video", {
        videoId: ref.id,
        knownSpotNames: trip.spots.map((s) => s.name),
      });
      trip = getLocalTrip(tripId);
      if (!trip) return;
      const added = applyVideoResult(trip, result);
      trip.progress = `Finished "${result.video.title}" — found ${added} new spots.`;
      save(trip);
    } catch (err) {
      trip = getLocalTrip(tripId);
      if (!trip) return;
      const v = trip.videos.find((x) => x.id === ref.id)!;
      v.status = "error";
      v.error = err instanceof Error ? err.message : String(err);
      save(trip);
    }
  }
}

/** Adds pasted video links to an existing local trip and processes them. */
export function addVideosToTrip(tripId: string, videoIds: { id: string; url: string }[]) {
  const trip = getLocalTrip(tripId);
  if (!trip) return;
  for (const v of videoIds) {
    if (trip.videos.some((x) => x.id === v.id)) continue;
    trip.videos.push({ ...pendingVideo(v.id), url: v.url });
  }
  trip.status = "processing";
  trip.progress = "Processing new videos…";
  saveLocalTrip(trip);
  ensureRunning(tripId);
}
