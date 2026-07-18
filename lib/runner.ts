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
      }>("/api/discover", {
        ...trip.query,
        // For LLM analytics: lets traces/costs be filtered per trip
        tripId: trip.id,
        tripName: trip.name,
      });

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

/**
 * How many videos to read at once. Each /api/process-video call fetches a
 * YouTube transcript through the shared residential proxy, so we keep this
 * modest: too many concurrent fetches from one IP raises YouTube's bot-check
 * odds, and the win from more lanes flattens out quickly anyway.
 */
const CONCURRENCY = 4;

async function processPending(tripId: string) {
  const start = getLocalTrip(tripId);
  if (!start) return;

  const pendingIds = start.videos
    .filter((v) => v.status === "pending")
    .map((v) => v.id);
  if (pendingIds.length === 0) return;

  // Flip every pending video to "processing" in one write so the UI shows the
  // whole batch spinning at once, then fan the requests out.
  for (const id of pendingIds) {
    const v = start.videos.find((x) => x.id === id);
    if (v) v.status = "processing";
  }
  start.status = "processing";
  start.progress =
    pendingIds.length === 1
      ? "Reading transcript — extracting spots with Claude…"
      : `Reading ${pendingIds.length} transcripts in parallel — extracting spots with Claude…`;
  save(start);

  const queue = [...pendingIds];
  let done = 0;

  async function worker() {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      await processOne(tripId, id, pendingIds.length, () => ++done);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pendingIds.length) }, worker)
  );
}

/** Reads and folds in a single video. Each getLocalTrip→save is synchronous
 *  (no await between), so concurrent workers never clobber each other's writes. */
async function processOne(
  tripId: string,
  videoId: string,
  total: number,
  markDone: () => number
) {
  let trip = getLocalTrip(tripId);
  if (!trip) return;

  try {
    const result = await post<VideoResult>("/api/process-video", {
      videoId,
      // Fresh snapshot: videos finished so far have already merged in their
      // spots, so later requests can skip re-resolving them. Anything that
      // slips through parallel timing is de-duped by applyVideoResult.
      knownSpotNames: trip.spots.map((s) => s.name),
      // For LLM analytics: lets traces/costs be filtered per trip
      tripId: trip.id,
      tripName: trip.name,
    });
    trip = getLocalTrip(tripId);
    if (!trip) return;
    const added = applyVideoResult(trip, result);
    const n = markDone();
    trip.progress = `Read ${n}/${total} — "${result.video.title}" added ${added} new spot${added === 1 ? "" : "s"}.`;
    save(trip);
  } catch (err) {
    trip = getLocalTrip(tripId);
    if (!trip) return;
    markDone();
    const v = trip.videos.find((x) => x.id === videoId)!;
    v.status = "error";
    v.error = err instanceof Error ? err.message : String(err);
    save(trip);
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
