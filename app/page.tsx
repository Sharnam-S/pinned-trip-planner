"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trip } from "@/lib/types";
import {
  deleteLocalTrip,
  listLocalTrips,
  newTripId,
  readOwnedIds,
  saveLocalTrip,
  subscribeLocalTrips,
  unpublishTrip,
} from "@/lib/clientStore";
import { newSearchTrip } from "@/lib/merge";
import { ensureRunning } from "@/lib/runner";
import { Logo } from "@/components/Logo";

// The preview iframe renders the trip page at a fixed desktop size, then
// scales it down to fit its frame. The page header (back link + title) is
// cropped so the preview starts at the category chips.
const PREVIEW_W = 1600;
const PREVIEW_H = 1000;
const PREVIEW_CROP = 110;

export default function Home() {
  const router = useRouter();
  const [localTrips, setLocalTrips] = useState<Trip[]>([]);
  const [shared, setShared] = useState<Trip[]>([]);
  const [ownedIds, setOwnedIds] = useState<string[]>([]);
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [interests, setInterests] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setLocalTrips(listLocalTrips());
      setOwnedIds(readOwnedIds());
    };
    sync();
    const unsub = subscribeLocalTrips(sync);
    // The shared library: repo samples + everything published to Blob.
    fetch("/api/trips")
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setShared(data))
      .catch(() => {});
    return unsub;
  }, []);

  // One deduped list: your in-progress local trips merged over the shared
  // library (a local copy is the freshest on this machine, so it wins).
  const allTrips = useMemo(() => {
    const byId = new Map<string, Trip>();
    for (const t of shared) byId.set(t.id, t);
    for (const t of localTrips) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }, [shared, localTrips]);

  // Trips this browser may delete: anything it created locally or owns in the
  // shared library.
  const deletableIds = useMemo(() => {
    const s = new Set(ownedIds);
    for (const t of localTrips) s.add(t.id);
    return s;
  }, [ownedIds, localTrips]);

  const totalSpots = useMemo(
    () => allTrips.reduce((n, t) => n + t.spots.length, 0),
    [allTrips]
  );

  const selectedTrip = useMemo(
    () =>
      allTrips.find((t) => t.id === selectedTripId) ??
      allTrips.find((t) => t.status === "ready" && t.spots.length > 0) ??
      allTrips[0] ??
      null,
    [allTrips, selectedTripId]
  );

  function removeTrip(id: string) {
    deleteLocalTrip(id); // no-op if it isn't a local trip
    void unpublishTrip(id); // remove from the shared library + owned set
  }

  function createTrip() {
    setError("");
    if (!destination.trim()) {
      setError("Tell us where you're going.");
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      setError("The end date is before the start date.");
      return;
    }
    setCreating(true);
    const id = newTripId();
    const trip = newSearchTrip(id, {
      destination: destination.trim(),
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      interests: interests.trim() || undefined,
    });
    if (!saveLocalTrip(trip)) {
      setError("Your browser storage is full — delete an old trip first.");
      setCreating(false);
      return;
    }
    ensureRunning(id);
    router.push(`/trip/${id}`);
  }

  return (
    <main className="landing">
      {/* Soft clouds drifting behind everything */}
      <div className="cloud-layer" aria-hidden="true">
        <div className="cloud c1" />
        <div className="cloud c2" />
        <div className="cloud c3" />
      </div>

      <nav className="top-nav">
        <Logo className="brand" />
        <a className="nav-pill" href="/uploadtrip">
          Upload a trip
        </a>
      </nav>

      <section className="hero">
        {totalSpots > 0 && (
          <div className="stat-chip rise r1">
            <span className="stat-dot" />
            <strong>{totalSpots.toLocaleString()}</strong>&nbsp;spots pinned
          </div>
        )}
        <h1 className="rise r1">
Every YouTube travel
          <br />
          guide, mapped
        </h1>
        <p className="hero-sub rise r2">
          Tell us where you're going. We'll find the best YouTube videos, extract every recommendation, and build a map you can actually explore. 
        </p>

        <div className="search-bar rise r2">
          <div className="sb-field grow">
            <label htmlFor="dest">Where</label>
            <input
              id="dest"
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createTrip()}
              placeholder="Tbilisi, Georgia"
              disabled={creating}
            />
          </div>
          <div className="sb-divider" />
          <div className="sb-field">
            <label htmlFor="from">From</label>
            <input
              id="from"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={creating}
            />
          </div>
          <div className="sb-divider" />
          <div className="sb-field">
            <label htmlFor="to">To</label>
            <input
              id="to"
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={creating}
            />
          </div>
          <div className="sb-divider" />
          <div className="sb-field grow">
            <label htmlFor="interests">Interests</label>
            <input
              id="interests"
              type="text"
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createTrip()}
              placeholder="skiing, wine, street food…"
              disabled={creating}
            />
          </div>
          <button className="sb-cta" onClick={createTrip} disabled={creating}>
            {creating ? "Searching…" : "Build my map"}
          </button>
        </div>
        {error && <div className="hero-error">{error}</div>}
        <p className="hero-fineprint rise r2">
          Dates and interests are optional — they tune which videos we pick.
        </p>
      </section>

      {selectedTrip && (
        <section className="browser-frame">
          <div className="chrome">
            <div className="chrome-dots">
              <span />
              <span />
              <span />
            </div>
            <div className="chrome-url">
              <svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true">
                <rect x="1" y="5" width="9" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M3.2 5V3.8a2.3 2.3 0 014.6 0V5" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              pinned.app/trips
            </div>
            <div />
          </div>
          <div className="app-body">
            <aside className="rail">
              <div className="rail-label">Trips</div>
              {allTrips.map((t) => (
                <div
                  key={t.id}
                  className={`rail-row ${selectedTrip.id === t.id ? "on" : ""}`}
                >
                  <button
                    className="rail-name"
                    onClick={() => setSelectedTripId(t.id)}
                  >
                    <svg width="13" height="13" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                      <path
                        d="M11 20s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11z"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinejoin="round"
                      />
                      <circle cx="11" cy="9" r="2.5" stroke="currentColor" strokeWidth="2.2" />
                    </svg>
                    <span className="rail-text">{t.name}</span>
                    {t.status !== "ready" && (
                      <span className={`rail-status ${t.status}`} />
                    )}
                  </button>
                  {deletableIds.has(t.id) && (
                    <button
                      className="rail-del"
                      title="Delete this trip"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => removeTrip(t.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </aside>
            <TripPreview tripId={selectedTrip.id} />
          </div>
        </section>
      )}

      <footer className="landing-footer">
        <Logo className="foot-brand" markSize={27} />
        <p className="foot-tagline">Every place they raved about. On one map.</p>
        <p className="foot-note">
          Built from creators&rsquo; actual words — never sponsored lists.
        </p>
      </footer>
    </main>
  );
}

// A live, fully interactive desktop rendering of the real trip page, scaled
// to fit — filter chips, spot cards, and the map all work right here.
function TripPreview({ tripId }: { tripId: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / PREVIEW_W);
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);

  return (
    <div className="trip-preview" ref={wrapRef}>
      <iframe
        key={tripId}
        src={`/trip/${tripId}`}
        title="Live trip demo"
        width={PREVIEW_W}
        height={PREVIEW_H}
        style={{
          transform: `scale(${scale})`,
          marginTop: -PREVIEW_CROP * scale,
        }}
      />
      <a className="preview-open" href={`/trip/${tripId}`}>
        Open full trip ↗
      </a>
    </div>
  );
}
