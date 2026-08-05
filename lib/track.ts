/**
 * Client half of product analytics (see lib/analytics.ts for the why).
 *
 * Fire-and-forget by design: a dropped event is worth far less than a delayed
 * render or a thrown error in a build worker, so nothing here is awaited and
 * nothing here can throw. `keepalive` lets an event survive the navigation that
 * often follows the thing being measured.
 *
 * These stay server-captured rather than going through posthog-js: the route
 * allowlists event names, and it attaches the session identity that
 * `$ai_generation` is already keyed to. The browser SDK's job is the automatic
 * breadth — pageviews and autocapture — not these.
 */
import type { ProductEvent } from "./analytics";

type Props = Record<string, string | number | boolean | null | undefined>;

/** The browser SDK's distinct id, handed over by `components/Analytics.tsx`.
 *
 *  Signed-in visitors are keyed to `user.id` on both paths and merge on their
 *  own. ANONYMOUS ones didn't: the server keys them `anon:<tripId>` while the
 *  SDK uses its own uuid, so one visitor's pageviews and their build events
 *  arrived as two unrelated people and no funnel could cross that gap.
 *  Forwarding this lets the server use the same id. */
let clientDistinctId: string | null = null;

export function setClientDistinctId(id: string | null | undefined): void {
  clientDistinctId = id ?? null;
}

/** For the one caller that posts somewhere other than `/api/events` and still
 *  wants an anonymous sender to land on the same person (`/api/feedback`). */
export function getClientDistinctId(): string | null {
  return clientDistinctId;
}

export function track(event: ProductEvent, props: Props = {}): void {
  if (typeof window === "undefined") return;
  const properties: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) properties[k] = v;
  }
  try {
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        properties,
        ...(clientDistinctId ? { distinctId: clientDistinctId } : {}),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never break the thing it's measuring.
  }
}
