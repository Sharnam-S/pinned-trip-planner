/**
 * Browser-side trip builder. The server is stateless compute (search, Claude
 * extraction, geocoding); this module orchestrates the calls and saves every
 * step through `tripStore` — the account when signed in, localStorage when not
 * — so the UI can subscribe and render progress live.
 *
 * Runs are per-tab: closing the tab pauses a build, and the trip page resumes
 * it on the next visit (pending videos are picked up where they left off).
 */
import { publishTrip } from "./clientStore";
import { peekTrip, saveTrip, tripSaveError } from "./tripStore";
import { getSession } from "./useSession";
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
    // The route's own ceiling is maxDuration=300s. Past that the request is
    // never coming back, and a spinner that spins forever is worse than a
    // video marked failed and swapped for one from the bench.
    signal: AbortSignal.timeout(300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Request failed (${res.status})`
    );
  }
  return data as T;
}

/** Awaited at every step: a build that can't persist should stop, not keep
 *  spending extraction calls on results it will drop. The message comes from
 *  the store, which knows whether it was a full localStorage or a failed PUT. */
async function save(trip: Trip) {
  const ok = await saveTrip(trip);
  if (!ok) {
    throw new Error(
      tripSaveError() ?? "Couldn't save this trip — try again in a moment."
    );
  }
}

async function run(tripId: string) {
  let trip = peekTrip(tripId);
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
      await save(trip);
    }

    // Search-mode trip that hasn't found its videos yet
    if (trip.query && trip.videos.length === 0) {
      trip.status = "processing";
      trip.progress = "Planning YouTube searches…";
      await save(trip);

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

      trip = peekTrip(tripId);
      if (!trip) return;
      trip.query!.resolvedDestination = plan.resolvedDestination;
      trip.name = plan.resolvedDestination;
      trip.videos = plan.videos.map((v) => pendingVideo(v.id, v.title, v.channelName));
      trip.bench = plan.bench;
      trip.progress = `Picked ${trip.videos.length} videos — reading transcripts…`;
      await save(trip);
    }

    // Process pending videos, swapping caption-less picks from the bench
    for (let round = 0; round < 4; round++) {
      await processPending(tripId);
      const t = peekTrip(tripId);
      if (!t) return;
      const errored = t.videos.filter((v) => v.status === "error");
      if (errored.length === 0 || !t.bench || t.bench.length === 0) break;

      const subs = t.bench.splice(0, errored.length);
      t.videos = t.videos.filter((v) => v.status !== "error");
      t.videos.push(...subs.map((id) => pendingVideo(id)));
      t.progress = `${errored.length} video${errored.length === 1 ? " has" : "s have"} no captions — swapping in replacement${subs.length === 1 ? "" : "s"}…`;
      await save(t);
    }

    const finished = peekTrip(tripId);
    if (!finished) return;
    const allFailed =
      finished.videos.length > 0 &&
      finished.videos.every((v) => v.status === "error");
    finished.status = allFailed ? "error" : "ready";
    finished.progress = allFailed
      ? "All videos failed to process."
      : `Done — ${finished.spots.length} spots on the map.`;
    await save(finished);

    // With accounts, trips are private to their creator (the account syncs
    // them across devices) and the community library only gets trips the user
    // explicitly shares from the trip page. On a no-auth deploy the old
    // behavior stands: publish to the shared pool, it's the only cross-device
    // path. Best-effort — a publish failure never blocks the local trip.
    if (!allFailed && finished.spots.length > 0) {
      const done = finished;
      void getSession().then((s) => {
        if (!s.enabled) void publishTrip(done);
      });
    }
  } catch (err) {
    const t = peekTrip(tripId);
    if (!t) return;
    t.status = "error";
    t.progress = err instanceof Error ? err.message : String(err);
    void saveTrip(t);
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
  const start = peekTrip(tripId);
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
  await save(start);

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

/** Reads and folds in a single video. Each peekTrip→save is atomic within
 *  (no await between), so concurrent workers never clobber each other's writes. */
async function processOne(
  tripId: string,
  videoId: string,
  total: number,
  markDone: () => number
) {
  let trip = peekTrip(tripId);
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
    trip = peekTrip(tripId);
    if (!trip) return;
    const added = applyVideoResult(trip, result);
    const n = markDone();
    trip.progress = `Read ${n}/${total} — "${result.video.title}" added ${added} new spot${added === 1 ? "" : "s"}.`;
    await save(trip);
  } catch (err) {
    trip = peekTrip(tripId);
    if (!trip) return;
    markDone();
    const v = trip.videos.find((x) => x.id === videoId)!;
    v.status = "error";
    v.error = err instanceof Error ? err.message : String(err);
    await save(trip);
  }
}

/** Adds pasted video links to an existing local trip and processes them. */
export function addVideosToTrip(tripId: string, videoIds: { id: string; url: string }[]) {
  const trip = peekTrip(tripId);
  if (!trip) return;
  for (const v of videoIds) {
    if (trip.videos.some((x) => x.id === v.id)) continue;
    trip.videos.push({ ...pendingVideo(v.id), url: v.url });
  }
  trip.status = "processing";
  trip.progress = "Processing new videos…";
  void saveTrip(trip);
  ensureRunning(tripId);
}
