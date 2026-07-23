"use client";

/**
 * Background sync: localStorage stays the fast, offline-friendly working copy;
 * this module pushes owned trips (and their chats) to the account so they
 * survive the browser and follow the user across devices.
 *
 * Adoption rule: a local trip with no ownerId was created before sign-in (or
 * pre-accounts) — the first sync while signed in claims it for this account.
 * A trip owned by a DIFFERENT account (shared computer) is left alone and
 * never pushed.
 */
import { listLocalTrips, saveLocalTrip } from "./clientStore";
import { getSession } from "./useSession";
import { Trip } from "./types";

const PUSH_DEBOUNCE_MS = 2500;

// Cheap change detection so a page load doesn't re-push unchanged trips:
// djb2 over the serialized trip, remembered per id in localStorage.
const PUSHED_PREFIX = "pinned.pushed.";

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0) + ":" + s.length;
}

function lastPushed(id: string): string | null {
  try {
    return localStorage.getItem(PUSHED_PREFIX + id);
  } catch {
    return null;
  }
}

function rememberPushed(id: string, h: string) {
  try {
    localStorage.setItem(PUSHED_PREFIX + id, h);
  } catch {
    // best-effort — worst case we re-push next load
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function pushTrip(trip: Trip): Promise<void> {
  const body = JSON.stringify(trip);
  const h = hash(body);
  if (lastPushed(trip.id) === h) return;
  try {
    const res = await fetch(`/api/trips/${trip.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.ok) rememberPushed(trip.id, h);
    // 403 (someone else's id) or transient failures: just don't remember —
    // owned trips retry on the next change/load, foreign ones keep 403ing
    // harmlessly at the debounce rate.
  } catch {
    // offline — the next local change retries
  }
}

/** Sweep all local trips: adopt unowned ones, debounce-push what changed. */
export async function syncLocalTrips(): Promise<void> {
  const session = await getSession();
  const me = session.user;
  if (!session.enabled || !me) return;

  for (const trip of listLocalTrips()) {
    if (trip.ownerId && trip.ownerId !== me.id) continue; // someone else's
    if (!trip.ownerId) {
      trip.ownerId = me.id;
      saveLocalTrip(trip); // re-fires the change event; hash check keeps it quiet
    }
    const existing = timers.get(trip.id);
    if (existing) clearTimeout(existing);
    timers.set(
      trip.id,
      setTimeout(() => {
        timers.delete(trip.id);
        void pushTrip(trip);
      }, PUSH_DEBOUNCE_MS)
    );
  }
}

// --- Chat sync (called by PlannerChat alongside its localStorage save) ---

const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced push of a trip's conversation. Only owned trips are sent. */
export function pushChatDebounced(tripId: string, messages: unknown[]): void {
  const existing = chatTimers.get(tripId);
  if (existing) clearTimeout(existing);
  chatTimers.set(
    tripId,
    setTimeout(async () => {
      chatTimers.delete(tripId);
      const session = await getSession();
      if (!session.enabled || !session.user) return;
      try {
        await fetch(`/api/trips/${tripId}/messages`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
        });
      } catch {
        // offline — the next save retries
      }
    }, PUSH_DEBOUNCE_MS)
  );
}

/** The account's saved conversation for a trip, or null (none / signed out). */
export async function fetchServerChat(tripId: string): Promise<unknown[] | null> {
  const session = await getSession();
  if (!session.enabled || !session.user) return null;
  try {
    const res = await fetch(`/api/trips/${tripId}/messages`);
    if (!res.ok) return null;
    const data = (await res.json()) as { messages?: unknown[] | null };
    return Array.isArray(data.messages) ? data.messages : null;
  } catch {
    return null;
  }
}
