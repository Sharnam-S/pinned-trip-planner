/**
 * Browser-side trip builder. The server is stateless compute (search, Claude
 * extraction, geocoding); this module orchestrates the calls and saves every
 * step through `tripStore` — the account when signed in, localStorage when not
 * — so the UI can subscribe and render progress live.
 *
 * Runs are per-tab: closing the tab pauses a build, and the trip page resumes
 * it on the next visit (pending videos are picked up where they left off).
 */
import { listLocalTrips, publishTrip } from "./clientStore";
import { loadTrip, peekTrip, saveTrip, tripSaveError } from "./tripStore";
import { getSession } from "./useSession";
import { applyVideoResult, pendingVideo, VideoResult } from "./merge";
import { Trip } from "./types";
import { track } from "./track";

const running = new Set<string>();
/** Trips whose `/api/discover` call is in flight. The `running` set alone was
 *  not enough: both the landing form and the trip page call `ensureRunning`, and
 *  a build was observed issuing TWO discover requests for one trip 18 seconds
 *  apart (two distinct PostHog traces) — ~27s and ~$0.03 of the traveler's
 *  ten-minute wait, spent finding the same twenty videos twice. */
const discovering = new Set<string>();

export function isRunning(tripId: string) {
  return running.has(tripId);
}

/** When each build started, for the duration on build_* events. Per-tab, like
 *  the run itself. */
const startedAt = new Map<string, number>();

function buildStartedAt(tripId: string): number {
  return startedAt.get(tripId) ?? Date.now();
}

/** Starts (or resumes) building a trip. No-op if already running in this tab. */
export function ensureRunning(tripId: string) {
  if (running.has(tripId)) return;
  running.add(tripId);
  startedAt.set(tripId, Date.now());
  void run(tripId).finally(() => running.delete(tripId));
}

/** A failed request that knows whether waiting would help. 429/503 come from
 *  `/api/process-video` when YouTube is throttling *us* rather than the video
 *  being unreadable — see TranscriptError in lib/youtube.ts. */
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "RequestError";
  }

  get transient(): boolean {
    return this.status === 429 || this.status === 503;
  }
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
    throw new RequestError(
      (data as { error?: string }).error ?? `Request failed (${res.status})`,
      res.status
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

    // Search-mode trip that hasn't found its videos yet. The `discovering` guard
    // is data-based on purpose: re-read the trip immediately before spending the
    // call, and never let a second runner start one while the first is waiting.
    if (trip.query && trip.videos.length === 0 && !discovering.has(tripId)) {
      discovering.add(tripId);
      try {
        trip.status = "processing";
        trip.progress = "Planning YouTube searches…";
        await save(trip);
        track("build_started", {
          tripId,
          destination: trip.query.destination,
          hasDates: Boolean(trip.query.startDate || trip.query.endDate),
          hasInterests: Boolean(trip.query.interests),
        });

        const plan = await post<{
          resolvedDestination: string;
          bounds: [[number, number], [number, number]] | null;
          subAreas?: string[];
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
        // Someone else got there while we were waiting — keep their result.
        if (trip.videos.length === 0) {
          trip.query!.resolvedDestination = plan.resolvedDestination;
          trip.name = plan.resolvedDestination;
          // Set BEFORE any video is processed — applyVideoResult reads it to
          // decide what belongs to this trip.
          if (plan.bounds) trip.bounds = plan.bounds;
          if (plan.subAreas?.length) trip.subAreas = plan.subAreas;
          trip.videos = plan.videos.map((v) =>
            pendingVideo(v.id, v.title, v.channelName)
          );
          trip.bench = plan.bench;
          trip.progress = `Picked ${trip.videos.length} videos — reading transcripts…`;
          await save(trip);
        }
      } finally {
        discovering.delete(tripId);
      }
    }

    // Process pending videos, swapping caption-less picks from the bench.
    // Only `error` earns a substitution: a `throttled` video is one YouTube
    // wouldn't serve us, and every bench pick would meet the same refusal.
    for (let round = 0; round < 4; round++) {
      await processPending(tripId);
      const t = peekTrip(tripId);
      if (!t) return;
      if (t.videos.some((v) => v.status === "throttled")) break;
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
    const throttled = finished.videos.filter((v) => v.status === "throttled");
    const done = finished.videos.filter((v) => v.status === "done");
    const allFailed =
      finished.videos.length > 0 &&
      finished.videos.every((v) => v.status === "error");

    const seconds = Math.round((Date.now() - buildStartedAt(tripId)) / 1000);
    if (throttled.length > 0) {
      track("build_failed", {
        tripId,
        failureKind: "rate-limited",
        seconds,
        videosOk: done.length,
        videosTotal: finished.videos.length,
        spots: finished.spots.length,
      });
      // Paused, not failed. Everything read so far is kept, the untried videos
      // stay pending, and the build screen offers Retry — the old behavior threw
      // the whole trip away over a temporary block.
      for (const v of finished.videos) {
        if (v.status === "throttled") v.status = "pending";
      }
      finished.status = "error";
      finished.progress =
        done.length > 0
          ? `YouTube is rate-limiting us. We read ${done.length} of ${finished.videos.length} videos — ${finished.spots.length} spots so far. Try again in a minute to finish the rest.`
          : "YouTube is rate-limiting us right now. Nothing is lost — try again in a minute.";
      await save(finished);
      return;
    }

    finished.status = allFailed ? "error" : "ready";
    finished.progress = allFailed
      ? "None of these videos had readable captions. Try again — we'll pick a different set."
      : `Done — ${finished.spots.length} spots on the map.`;
    await save(finished);
    track(allFailed ? "build_failed" : "build_completed", {
      tripId,
      failureKind: allFailed ? "no-captions" : null,
      seconds,
      videosOk: done.length,
      videosTotal: finished.videos.length,
      spots: finished.spots.length,
    });

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

  // Videos are marked "processing" by the worker that picks them up, NOT all at
  // once here. Flipping all twenty up front made the batch look busy, but a
  // reload then orphaned all twenty — the runner re-queues them from scratch and
  // the traveler watches twenty frozen spinners for three minutes while work
  // that was already paid for is redone. Marking per worker means a reload can
  // only ever lose the handful actually in flight.
  start.status = "processing";
  start.progress =
    pendingIds.length === 1
      ? "Reading transcript — extracting spots with Claude…"
      : // Say what actually happens. "20 in parallel" set up a wait the product
        // couldn't honour: only CONCURRENCY run at a time.
        `Reading ${pendingIds.length} transcripts, ${CONCURRENCY} at a time — extracting spots with Claude…`;
  await save(start);

  const queue = [...pendingIds];
  let done = 0;

  async function worker(lane: number) {
    // Stagger the lanes. Four caption downloads leaving in the same millisecond
    // is a large part of what earns a 429 in the first place.
    if (lane > 0) await new Promise((r) => setTimeout(r, lane * 200));
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      await processOne(tripId, id, pendingIds.length, () => ++done);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pendingIds.length) }, (_, i) =>
      worker(i)
    )
  );
}

/** Reads and folds in a single video. Each peekTrip→save is atomic within
 *  (no await between), so concurrent workers never clobber each other's writes. */
/** Backoff for a throttled video: ~8s, 20s, 45s, jittered so four workers
 *  don't all come back at the same instant and re-trip the limit. */
const RETRY_DELAYS_MS = [8_000, 20_000, 45_000];

async function processOne(
  tripId: string,
  videoId: string,
  total: number,
  markDone: () => number
) {
  let trip = peekTrip(tripId);
  if (!trip) return;

  // Claim it now, so an interrupted load leaves at most CONCURRENCY videos
  // orphaned rather than the whole queue.
  const claimed = trip.videos.find((v) => v.id === videoId);
  if (claimed) {
    claimed.status = "processing";
    await save(trip);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await post<VideoResult>("/api/process-video", {
        videoId,
        // Fresh snapshot: videos finished so far have already merged in their
        // spots, so later requests can skip re-resolving them. Anything that
        // slips through parallel timing is de-duped by applyVideoResult.
        knownSpotNames: trip!.spots.map((s) => s.name),
        // For LLM analytics: lets traces/costs be filtered per trip
        tripId: trip!.id,
        tripName: trip!.name,
      });
      trip = peekTrip(tripId);
      if (!trip) return;
      const hadSpots = trip.spots.length > 0;
      const added = applyVideoResult(trip, result);
      const n = markDone();
      trip.progress = `Read ${n}/${total} — "${result.video.title}" added ${added} new spot${added === 1 ? "" : "s"}.`;
      await save(trip);
      // The moment the wait stops being blank — the build screen hands over to
      // the live map here (see TripView's gate). Worth measuring on its own:
      // it's the number that turned a ten-minute stare into a ~40-second one.
      if (!hadSpots && trip.spots.length > 0) {
        track("first_pin_visible", {
          tripId,
          seconds: Math.round((Date.now() - buildStartedAt(tripId)) / 1000),
          videosRead: n,
        });
      }
      return;
    } catch (err) {
      trip = peekTrip(tripId);
      if (!trip) return;

      // Throttled or unreachable: the video is fine, we are. Wait and retry the
      // SAME video rather than marking it dead — a bench substitution would run
      // straight into the same wall, which is how a rate-limited build used to
      // consume all twenty backups and end as "All videos failed to process".
      const transient = err instanceof RequestError && err.transient;
      if (transient && attempt < RETRY_DELAYS_MS.length) {
        const wait = RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() * 0.5);
        trip.progress = `YouTube is rate-limiting us — retrying in ${Math.round(
          wait / 1000
        )}s…`;
        await save(trip);
        await new Promise((r) => setTimeout(r, wait));
        trip = peekTrip(tripId);
        if (!trip) return;
        continue;
      }

      markDone();
      const v = trip.videos.find((x) => x.id === videoId)!;
      // `throttled` is a distinct terminal state from `error`: the bench must
      // not be spent on it (see processPending), and the build screen offers a
      // retry instead of declaring the trip dead.
      v.status = transient ? "throttled" : "error";
      v.error = err instanceof Error ? err.message : String(err);
      await save(trip);
      return;
    }
  }
}

/**
 * Pick up any build that was interrupted, from anywhere in the app.
 *
 * Builds run in the browser, so closing the tab pauses one — that's the
 * architecture. What made it feel broken is that the ONLY thing that resumed a
 * paused build was opening its trip page: a traveler who reloaded, or came back
 * to the home page, saw an unfinished map and nothing happening, with no way to
 * know they had to click into the trip to restart it.
 *
 * Mounted globally (SyncAgent), this makes "come back to the site" enough.
 */
export async function resumeInterruptedBuilds(): Promise<void> {
  if (typeof window === "undefined") return;
  let ids: string[] = [];
  try {
    const session = await getSession();
    if (session.enabled && session.user) {
      // Signed in: the account knows which trips are mid-build, on any device.
      const res = await fetch("/api/me/trips");
      if (!res.ok) return;
      const trips = (await res.json()) as { id: string; status: string }[];
      ids = trips.filter((t) => t.status === "processing").map((t) => t.id);
    } else {
      ids = listLocalTrips()
        .filter((t) => t.status === "processing")
        .map((t) => t.id);
    }
  } catch {
    return;
  }

  for (const id of ids) {
    if (running.has(id)) continue;
    // The runner reads the trip out of the store, so it has to be loaded first.
    const trip = await loadTrip(id);
    if (!trip || trip.status !== "processing") continue;
    const live = peekTrip(id);
    if (live) {
      live.progress = "Picking up where we left off…";
      void saveTrip(live);
    }
    ensureRunning(id);
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
