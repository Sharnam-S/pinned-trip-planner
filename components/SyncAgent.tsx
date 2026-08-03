"use client";

/**
 * Invisible, mounted once in the root layout. Two jobs:
 *
 * 1. Keep the signed-in user's localStorage trips flowing up to their account.
 *    Sweeps on mount (catches pre-sign-in trips to adopt) and on every
 *    local-trip change (build progress, itinerary edits, stars).
 * 2. Restart any build that was interrupted. Builds run in the browser, so
 *    closing the tab pauses one — but until now the ONLY thing that resumed a
 *    paused build was opening its trip page. Reload, or come back to the home
 *    page, and you'd find an unfinished map with nothing happening and no way
 *    to know you had to click into the trip to restart it. Being on the site is
 *    now enough.
 */
import { useEffect } from "react";
import { subscribeLocalTrips } from "@/lib/clientStore";
import { syncLocalTrips } from "@/lib/sync";
import { resumeInterruptedBuilds } from "@/lib/runner";

export default function SyncAgent() {
  useEffect(() => {
    void syncLocalTrips();
    void resumeInterruptedBuilds();
    // Coming back to a backgrounded tab is the other moment a stalled build
    // should pick itself up — phones suspend timers and sockets aggressively.
    const onVisible = () => {
      if (document.visibilityState === "visible") void resumeInterruptedBuilds();
    };
    document.addEventListener("visibilitychange", onVisible);
    const stop = subscribeLocalTrips(() => void syncLocalTrips());
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      stop();
    };
  }, []);
  return null;
}
