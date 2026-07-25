"use client";

import { useSyncExternalStore } from "react";

// Below this the phone layouts take over (trip page: map + bottom sheet;
// landing: glass hero). Must match the CSS mobile breakpoint.
const MOBILE_QUERY = "(max-width: 900px)";

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(MOBILE_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false // SSR: styled for desktop; corrected on hydration
  );
}
