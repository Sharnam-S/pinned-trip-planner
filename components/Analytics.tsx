"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { getSession } from "@/lib/useSession";
import { setClientDistinctId } from "@/lib/track";

/**
 * Client-side PostHog: pageviews and autocapture.
 *
 * The app had none. Every event in the project came from the server — the
 * build lifecycle, the agent's behaviour, the briefing — which answers "did
 * this work?" perfectly and "what did they do?" not at all. 96 click handlers,
 * two of them instrumented. Questions as basic as "does anyone use the
 * parallel plan options" had no data behind them.
 *
 * Two rules this has to respect, both inherited from the server half:
 *
 *  1. SAME IDENTITY. `captureProductEvent` keys events to `user.id`
 *     ("google:<sub>"). If the browser SDK invented its own id for signed-in
 *     people, every human would become two persons and every funnel would
 *     quietly under-count. So we identify with exactly that id.
 *  2. NO PROFILE FOR ANONYMOUS VISITORS. The server sets
 *     `$process_person_profile: false` so a stream of one-off visitors can't
 *     inflate the person count; `identified_only` is the client's version of
 *     the same decision.
 */
/** React StrictMode runs effects twice in dev, and `posthog.__loaded` isn't set
 *  synchronously enough to catch it — the SDK bootstrapped twice. */
let started = false;

export default function Analytics() {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || started) return;
    started = true;

    posthog.init(key, {
      // posthog-js resolves several behaviours from `defaults`; omitting it
      // leaves them in an "unset" legacy state.
      defaults: "2025-05-24",
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      // Rule 2 above.
      person_profiles: "identified_only",
      // Next's App Router does client-side navigation, which the SDK's default
      // history tracking handles; leaving capture_pageview on is what makes
      // landing → trip funnels possible at all.
      capture_pageview: true,
      capture_pageleave: true,
      // The trip page is a Leaflet canvas. Autocapture there is thousands of
      // meaningless map drags, so pins and tiles are excluded by class and the
      // decisions that matter are tracked by name instead (lib/track.ts).
      autocapture: {
        css_selector_allowlist: ["button", "a", "[role='button']", "[role='tab']"],
      },
      // Trip names and destinations are the traveler's own words. Keep them
      // out of URLs-as-properties by default.
      mask_personal_data_properties: true,
    });

    // Rule 1 above. `getSession` is cached, so this is one call per load.
    void getSession()
      .then((s) => {
        if (!s.enabled || !s.user) return;
        posthog.identify(s.user.id, {
          email: s.user.email,
          name: s.user.name ?? undefined,
        });
      })
      .catch(() => {
        // Analytics must never break the page it measures.
      });

    // Anonymous product events are keyed `anon:<tripId>` server-side, which
    // never lines up with the SDK's own id — so the same visitor's pageviews
    // and their build events land as two people. Handing the id to `track()`
    // stitches them.
    setClientDistinctId(posthog.get_distinct_id());
  }, []);

  return null;
}
