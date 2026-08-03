/**
 * Client half of product analytics (see lib/analytics.ts for the why).
 *
 * Fire-and-forget by design: a dropped event is worth far less than a delayed
 * render or a thrown error in a build worker, so nothing here is awaited and
 * nothing here can throw. `keepalive` lets an event survive the navigation that
 * often follows the thing being measured.
 */
import type { ProductEvent } from "./analytics";

type Props = Record<string, string | number | boolean | null | undefined>;

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
      body: JSON.stringify({ event, properties }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never break the thing it's measuring.
  }
}
