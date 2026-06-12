/**
 * Browser-side trip storage. Every visitor keeps their own trips in
 * localStorage — nothing they create is stored on the server. One key per
 * trip plus an id index, so saving a trip doesn't rewrite the others.
 */
import { Trip } from "./types";

const INDEX_KEY = "pinned.trip-ids";
const TRIP_PREFIX = "pinned.trip.";
const OWNED_KEY = "pinned.owned-ids"; // ids this browser published/uploaded
const CHANGE_EVENT = "pinned-trips-changed";

function hasStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function readIndex(): string[] {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function listLocalTrips(): Trip[] {
  return readIndex()
    .map((id) => getLocalTrip(id))
    .filter((t): t is Trip => t !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getLocalTrip(id: string): Trip | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(TRIP_PREFIX + id);
    return raw ? (JSON.parse(raw) as Trip) : null;
  } catch {
    return null;
  }
}

export function saveLocalTrip(trip: Trip): boolean {
  if (!hasStorage()) return false;
  try {
    localStorage.setItem(TRIP_PREFIX + trip.id, JSON.stringify(trip));
    const ids = readIndex();
    if (!ids.includes(trip.id)) {
      ids.push(trip.id);
      localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
    }
    notify();
    return true;
  } catch {
    // quota exceeded — surface it instead of silently losing the trip
    return false;
  }
}

export function deleteLocalTrip(id: string) {
  if (!hasStorage()) return;
  localStorage.removeItem(TRIP_PREFIX + id);
  localStorage.setItem(
    INDEX_KEY,
    JSON.stringify(readIndex().filter((x) => x !== id))
  );
  notify();
}

function notify() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Re-render hook: fires on any local-trip change in this tab. */
export function subscribeLocalTrips(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, cb);
  // also catch changes from other tabs
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("pinned.")) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function newTripId(): string {
  // same shape as the old server ids — 12 hex chars
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// --- Ownership: which shared trips this browser may delete/un-publish ---

export function readOwnedIds(): string[] {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(OWNED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function markOwned(id: string) {
  if (!hasStorage()) return;
  const ids = readOwnedIds();
  if (!ids.includes(id)) {
    localStorage.setItem(OWNED_KEY, JSON.stringify([...ids, id]));
    notify();
  }
}

export function unmarkOwned(id: string) {
  if (!hasStorage()) return;
  localStorage.setItem(
    OWNED_KEY,
    JSON.stringify(readOwnedIds().filter((x) => x !== id))
  );
  notify();
}

/**
 * Publish a finished trip to the shared library and remember we own it.
 * Best-effort: a failure (offline, no Blob store) leaves the local copy
 * untouched. Returns true on success.
 */
export async function publishTrip(trip: Trip): Promise<boolean> {
  try {
    const res = await fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trip),
    });
    if (!res.ok) return false;
    markOwned(trip.id);
    return true;
  } catch {
    return false;
  }
}

/** Remove a trip from the shared library (and our owned set). */
export async function unpublishTrip(id: string): Promise<void> {
  try {
    await fetch(`/api/trips/${id}`, { method: "DELETE" });
  } catch {
    // ignore — deletion is idempotent from the UI's perspective
  }
  unmarkOwned(id);
}
