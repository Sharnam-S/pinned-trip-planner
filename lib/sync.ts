"use client";

/**
 * Migration, not ongoing sync. Signed in, `tripStore` writes straight to the
 * account, so nothing new lands in localStorage; what's left there is history —
 * trips built before this change, or built while signed out. This module lifts
 * those into the account and then RECLAIMS the space.
 *
 * The reclaim is the point: localStorage holds ~5M characters, a built trip is
 * hundreds of KB, and a browser that filled up fails every save (including a
 * build's) even though the same trips are already safe in Postgres. Deleting a
 * local copy is only safe after the server has acknowledged it, so that's the
 * order — PUT, 200, then remove.
 *
 * Adoption rule: a local trip with no ownerId was created before sign-in (or
 * pre-accounts) — the first sweep while signed in claims it for this account.
 * A trip owned by a DIFFERENT account (shared computer) is left alone and
 * never pushed.
 */
import { deleteLocalTrip, listLocalTrips } from "./clientStore";
import { isRunning } from "./runner";
import { getSession } from "./useSession";
import { Trip } from "./types";

const PUSH_DEBOUNCE_MS = 2500;

// Cheap change detection so a page load doesn't re-push unchanged trips:
// djb2 over the serialized trip, remembered per id in localStorage.
const PUSHED_PREFIX = "pinned.pushed.";
const CHAT_PREFIX = "pinned.chat.";

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0) + ":" + s.length;
}

function rememberPushed(id: string, h: string) {
  try {
    localStorage.setItem(PUSHED_PREFIX + id, h);
  } catch {
    // best-effort — worst case we re-push next load
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Push a leftover local trip, then drop the local copy (and its chat) once the
 *  server owns it. Returns true when the space was reclaimed. */
async function migrateTrip(trip: Trip): Promise<boolean> {
  const body = JSON.stringify(trip);
  const h = hash(body);
  try {
    const res = await fetch(`/api/trips/${trip.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // 403 (someone else's id) or transient failures: keep the local copy and
    // retry on the next sweep — losing a trip is far worse than a full quota.
    if (!res.ok) return false;
    rememberPushed(trip.id, h);
    await migrateChat(trip.id);
    reclaim(trip.id);
    return true;
  } catch {
    // offline — the next sweep retries
    return false;
  }
}

/** Send this browser's saved conversation up, unless the account already has
 *  one (the server copy is the same messages, pushed earlier). */
async function migrateChat(tripId: string): Promise<void> {
  let local: string | null = null;
  try {
    local = localStorage.getItem(CHAT_PREFIX + tripId);
  } catch {
    return;
  }
  if (!local) return;
  try {
    const existing = await fetch(`/api/trips/${tripId}/messages`);
    const data = existing.ok
      ? ((await existing.json()) as { messages?: unknown[] | null })
      : null;
    if (Array.isArray(data?.messages) && data.messages.length > 0) return;
    await fetch(`/api/trips/${tripId}/messages`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: JSON.parse(local) }),
    });
  } catch {
    // leave the local copy; it'll be tried again
  }
}

/** Everything this browser was keeping for a trip that now lives in the
 *  account. Chat is the second-biggest consumer after the trip itself. */
function reclaim(tripId: string): void {
  try {
    localStorage.removeItem(CHAT_PREFIX + tripId);
    localStorage.removeItem(PUSHED_PREFIX + tripId);
  } catch {
    // nothing to do — the space just stays used
  }
  deleteLocalTrip(tripId);
}

/** Sweep whatever localStorage still holds: adopt unowned trips, push them to
 *  the account, free the space. Idempotent, and a no-op once nothing is left. */
export async function syncLocalTrips(): Promise<void> {
  const session = await getSession();
  const me = session.user;
  if (!session.enabled || !me) return;

  for (const trip of listLocalTrips()) {
    if (trip.ownerId && trip.ownerId !== me.id) continue; // someone else's
    if (!trip.ownerId) trip.ownerId = me.id;
    // A build in progress is mid-write from the runner; migrating underneath it
    // would race. It'll be picked up on the next sweep, once it's done.
    if (trip.status === "processing" || isRunning(trip.id)) continue;
    const existing = timers.get(trip.id);
    if (existing) clearTimeout(existing);
    timers.set(
      trip.id,
      setTimeout(() => {
        timers.delete(trip.id);
        void migrateTrip(trip);
      }, PUSH_DEBOUNCE_MS)
    );
  }
}

// --- Chat sync ---

/** Hash of the last conversation successfully sent, per trip: a page load reads
 *  the account's copy and would otherwise immediately write it back. */
const chatPushed = new Map<string, string>();

/**
 * Send a trip's conversation to the account. Called when a TURN ENDS, not on a
 * timer: a debounce is a race against the user navigating away, and it lost —
 * the reported symptom was a finished plan whose last turn was missing from the
 * conversation, because the push was still pending when the page changed.
 *
 * `beacon` uses sendBeacon for the page-unload path: a normal fetch dies with
 * the document, and keepalive caps the body at 64KB, which a chat carrying tool
 * payloads exceeds.
 */
export function pushChat(
  tripId: string,
  messages: unknown[],
  beacon = false
): void {
  const body = JSON.stringify({ messages });
  const h = hash(body);
  if (chatPushed.get(tripId) === h) return;
  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(
      `/api/trips/${tripId}/messages`,
      new Blob([body], { type: "application/json" })
    );
    if (sent) chatPushed.set(tripId, h);
    return;
  }
  // Claimed before the request, not after: unmounting fires a flush while this
  // one is still open, and two identical writes is one too many.
  chatPushed.set(tripId, h);
  void (async () => {
    const session = await getSession();
    if (!session.enabled || !session.user) return;
    try {
      const res = await fetch(`/api/trips/${tripId}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      // 409 = the trip row isn't there yet; let the next turn retry.
      if (!res.ok) chatPushed.delete(tripId);
    } catch {
      chatPushed.delete(tripId); // offline — the next completed turn tries again
    }
  })();
}

/** Remember what the account already has, so seeding a conversation from it
 *  doesn't bounce straight back as a write. */
export function noteChatFromServer(tripId: string, messages: unknown[]): void {
  chatPushed.set(tripId, hash(JSON.stringify({ messages })));
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
