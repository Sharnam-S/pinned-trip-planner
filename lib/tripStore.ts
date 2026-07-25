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
 *  don't have to: writes queue behind it. */
export function tripStoreMode(): Promise<Mode> {
  if (mode) return Promise.resolve(mode);
  probe ??= getSession()
    .then((s) => (mode = s.enabled && s.user ? "server" : "local"))
    .catch(() => (mode = "local"));
  return probe;
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

/** The trip as this tab currently understands it. Synchronous: the working
 *  copy, falling back to localStorage for signed-out users and for a trip this
 *  tab created before `loadTrip` ran. */
export function peekTrip(id: string): Trip | null {
  return working.get(id) ?? getLocalTrip(id);
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
    return cached;
  }
  if (at === "server") {
    const fresh = await fetchTrip(id);
    if (fresh && fresh !== "unchanged") {
      working.set(id, fresh);
      notifyTripsChanged();
      return fresh;
    }
  }
  const local = getLocalTrip(id);
  if (local) working.set(id, local);
  return local;
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
  const at = await tripStoreMode();
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
 *  promise that covers their own write. */
async function drain(id: string): Promise<boolean> {
  let ok = true;
  try {
    while (dirty.delete(id)) {
      const trip = working.get(id);
      if (!trip) break;
      ok = (await writeThrough(trip)) && ok;
    }
  } finally {
    inFlight.delete(id);
  }
  return ok;
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
