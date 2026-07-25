"use client";

/**
 * Invisible, mounted once in the root layout: keeps the signed-in user's
 * localStorage trips flowing up to their account. Sweeps on mount (catches
 * pre-sign-in trips to adopt) and on every local-trip change (build progress,
 * itinerary edits, stars — anything that calls saveTrip).
 */
import { useEffect } from "react";
import { subscribeLocalTrips } from "@/lib/clientStore";
import { syncLocalTrips } from "@/lib/sync";

export default function SyncAgent() {
  useEffect(() => {
    void syncLocalTrips();
    return subscribeLocalTrips(() => void syncLocalTrips());
  }, []);
  return null;
}
