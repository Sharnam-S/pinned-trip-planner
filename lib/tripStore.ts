"use client";

/**
 * Where a trip lives, in one place.
 *
 * Signed in, the account's Postgres row is the source of truth: the browser
 * holds a working copy in memory and writes through to `PUT /api/trips/:id`.
 * Signed out, there's no account to write to, so localStorage is the source of
 * truth exactly as before.
 *
 * This replaced localStorage-for-everyone, which had a hard ceiling: ~5M
 * characters per origin, against ~3.4KB per spot plus a chat history holding
 * whole itineraries per tool call. A few built trips filled it, and every save
 * during a build then failed ("your browser storage is full") even though the
 * same trips were already sitting safely in Neon.
 *
 * The shape callers see is deliberately unchanged: read the trip, mutate it,
 * save it. `saveTrip` updates the in-memory copy and notifies subscribers
 * synchronously — the map still re-renders the instant an agent tool lands —
 * and returns a promise that resolves once the write is durable, for the
 * callers that need to know (the build aborts rather than processing 20 videos
 * into a void).
 */
import {
  deleteLocalTrip,
  getLocalTrip,
  notifyTripsChanged,
  saveLocalTrip,
  subscribeLocalTrips,
} from "./clientStore";
import { getSession } from "./useSession";
import type { Trip } from "./types";

type Mode = "server" | "local";

/** The working copy. In server mode this is the only client-side copy — the
 *  point of the change is that trips stop being written to localStorage. */
const working = new Map<string, Trip>();

let mode: Mode | null = null;
let probe: Promise<Mode> | null = null;

/** Resolved once per page load. Callers that can't await it (click handlers)
 *  don't have to: writes never block on it (see `writeThrough`). */
export function tripStoreMode(): Promise<Mode> {
  if (mode) return Promise.resolve(mode);
  probe ??= getSession()
    .then((s) => (mode = s.enabled && s.user ? "server" : "local"))
    .catch(() => (mode = "local"));
  return probe;
}

/** Where a write for THIS trip goes, decided without awaiting anything. The
 *  session probe is a network call, and a network call can hang: when it did,
 *  every save queued behind it forever and a build sat there with all its
 *  videos spinning and not one request sent. An ownerId is a good enough answer
 *  on its own — the trip already belongs to an account — and an ownerless trip
 *  belongs in localStorage anyway, which is where it goes if we can't tell yet.
 *  Either way the probe keeps resolving in the background for later writes. */
function writeTarget(trip: Trip): Mode {
  if (mode) return mode;
  void tripStoreMode();
  return trip.ownerId ? "server" : "local";
}

// --- Errors ---
// A failed PUT is the one thing that can lose work, so it's surfaced rather
// than swallowed: the build stops on it and the UI can say so.

type ErrorListener = (message: string | null) => void;
const errorListeners = new Set<ErrorListener>();
let lastError: string | null = null;

export function onTripSaveError(cb: ErrorListener): () => void {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

function reportError(message: string | null) {
  lastError = message;
  for (const cb of errorListeners) cb(message);
}

export function tripSaveError(): string | null {
  return lastError;
}

// --- Reads ---

/** The LIVE trip, for code that mutates it: read, change, `saveTrip`. Build
 *  workers run four at a time and rely on sharing this one object — each folds
 *  its video into the same arrays, so cloning here would drop merges. */
export function peekTrip(id: string): Trip | null {
  return working.get(id) ?? getLocalTrip(id);
}

/** The trip as an immutable copy, for React state.
 *
 *  Not a nicety. Callers mutate the live object in place (the build sets
 *  `videos[i].status`, the agent pushes onto `spots`), so handing that object to
 *  `setTrip` means the value React is already holding changes underneath it:
 *  the update looks like nothing changed, React skips the render, and the screen
 *  freezes while the work continues behind it. That is what left a build showing
 *  twenty spinning videos and "0 of 20" until it finished and swapped to the map.
 *  Copying just the top level doesn't help — the arrays the screen reads are the
 *  ones being mutated.
 *
 *  Invisible before trips moved to the account: every read was a fresh
 *  `JSON.parse` of localStorage, so each render got its own copy for free. */
export function snapshotTrip(id: string): Trip | null {
  const live = peekTrip(id);
  return live ? structuredClone(live) : null;
}

/** Fetch a trip into the working copy. Server mode asks the account first and
 *  falls back to localStorage (a trip created while signed out, not yet
 *  migrated); local mode is localStorage only. Returns null when neither has
 *  it — the caller then tries samples/published copies.
 *
 *  A trip already in the working copy is returned immediately and refreshed
 *  behind the render: reopening a trip in the same tab used to re-download the
 *  whole document (~240KB) before anything appeared. */
export async function loadTrip(id: string): Promise<Trip | null> {
  const at = await tripStoreMode();
  const cached = working.get(id);
  if (cached) {
    if (at === "server") void revalidate(id);
    return structuredClone(cached);
  }
  if (at === "server") {
    const fresh = await fetchTrip(id);
    if (fresh && fresh !== "unchanged") {
      working.set(id, fresh);
      notifyTripsChanged();
      return structuredClone(fresh);
    }
  }
  const local = getLocalTrip(id);
  if (local) working.set(id, local);
  return local ? structuredClone(local) : null;
}

/** The route's ETag per trip, so a re-read of an unchanged trip costs a header
 *  exchange instead of a few hundred KB. `cache: "no-cache"` also lets the
 *  browser's own cache revalidate across page loads (where this map is empty),
 *  but the conditional request is sent explicitly rather than left to cache
 *  heuristics we can't see. */
const etags = new Map<string, string>();

/** The account's copy, "unchanged" when the ETag still matches, or null if it
 *  isn't this user's trip. */
async function fetchTrip(
  id: string,
  conditional = false
): Promise<Trip | "unchanged" | null> {
  const known = conditional ? etags.get(id) : undefined;
  try {
    const res = await fetch(`/api/trips/${id}`, {
      cache: "no-cache",
      headers: known ? { "If-None-Match": known } : undefined,
    });
    if (res.status === 304) return "unchanged";
    if (!res.ok) return null;
    const trip = (await res.json()) as Trip;
    // Only the account's own copy is authoritative; a public sample coming back
    // from the same route is not this user's trip to edit.
    if (trip?.id !== id || !trip.ownerId) return null;
    const tag = res.headers.get("etag");
    if (tag) etags.set(id, tag);
    delete trip.upgrading;
    return trip;
  } catch {
    return null; // offline: keep whatever this browser has
  }
}

/** Refresh a cached trip in the background (another device may have edited it).
 *  Skipped while this tab has unsaved or in-flight changes — ours are newer. */
async function revalidate(id: string): Promise<void> {
  if (dirty.has(id) || inFlight.has(id)) return;
  const fresh = await fetchTrip(id, true);
  if (fresh === "unchanged" || !fresh) return;
  if (dirty.has(id) || inFlight.has(id)) return;
  if (JSON.stringify(fresh) === JSON.stringify(working.get(id))) return;
  working.set(id, fresh);
  notifyTripsChanged();
}

// --- Writes ---

const dirty = new Set<string>();
const inFlight = new Map<string, Promise<boolean>>();

async function writeThrough(trip: Trip): Promise<boolean> {
  const at = writeTarget(trip);
  if (at === "local") {
    const ok = saveLocalTrip(trip);
    reportError(
      ok ? null : "Your browser storage is full — sign in, or delete an old trip."
    );
    return ok;
  }
  // One retry: a single blip shouldn't stop a build that took minutes.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`/api/trips/${trip.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trip),
        // Bounded on purpose: an unanswered request is indistinguishable from a
        // slow one, and the build is waiting on this to decide whether to carry
        // on. A timeout is a retryable failure; a hang is a dead build.
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        etags.delete(trip.id); // the account's copy just changed
        reportError(null);
        return true;
      }
      // 403 = someone else's id; retrying won't help.
      if (res.status === 403) break;
    } catch {
      // network — retry once
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  reportError("Couldn't save to your account — check your connection.");
  return false;
}

/** Coalesced write-behind: one request per trip at a time, and a save that
 *  lands mid-flight re-sends the newest copy when it finishes. Callers get a
 *  promise that covers their own write.
 *
 *  Retiring the drain and finding it clean happen in ONE synchronous block on
 *  purpose. With the `dirty` check and `inFlight.delete` in separate ticks, a
 *  save landing between them would be handed this promise — already past its
 *  last check — and reported as durable without ever being written. */
async function drain(id: string): Promise<boolean> {
  let ok = true;
  for (;;) {
    const pending = dirty.delete(id);
    const trip = pending ? working.get(id) : undefined;
    if (!trip) {
      inFlight.delete(id);
      return ok;
    }
    ok = (await writeThrough(trip)) && ok;
  }
}

/** Store a trip. The working copy and subscribers update synchronously; the
 *  returned promise resolves false if it couldn't be persisted. */
export function saveTrip(trip: Trip): Promise<boolean> {
  compactPhotos(trip);
  working.set(trip.id, trip);
  dirty.add(trip.id);
  notifyTripsChanged();
  const existing = inFlight.get(trip.id);
  if (existing) return existing;
  const started = drain(trip.id);
  inFlight.set(trip.id, started);
  return started;
}

/** Drop the legacy Google photo-name lists once a spot can be served by index
 *  (placeId + a resolved google photo): /api/photo never used the names, and at
 *  ~1.9KB per spot they were about half of a stored trip. In place, so the
 *  working copy matches what gets stored — and so every existing trip shrinks
 *  the next time anything touches it. */
function compactPhotos(trip: Trip): void {
  for (const spot of trip.spots) {
    if (!spot.morePhotoNames || !spot.placeId) continue;
    const servedByIndex =
      spot.photo?.source === "google" ||
      (spot.photos?.some((p) => p.source === "google") ?? false);
    if (!servedByIndex) continue; // still needs the names (/api/photos by name)
    spot.morePhotos = spot.morePhotoNames.length;
    delete spot.morePhotoNames;
  }
}

export async function deleteTrip(id: string): Promise<void> {
  working.delete(id);
  dirty.delete(id);
  deleteLocalTrip(id); // no-op when there's no local copy
  if ((await tripStoreMode()) === "server") {
    await fetch(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
  }
}

/** Fires on any change from this tab (and, for signed-out users, other tabs). */
export const subscribeTrips = subscribeLocalTrips;
