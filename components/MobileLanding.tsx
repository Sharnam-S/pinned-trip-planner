"use client";

/**
 * The phone landing: a glass hero on the sky background with the trip form
 * as one card (Where / When / Interests), and the visitor's saved trips
 * behind a top-right control — opening it fades the base back and the trip
 * cards flow in. Restrained on purpose: hairline borders, no ornament, one
 * accent. Desktop keeps its own landing in app/page.tsx.
 */
import { ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DatePicker from "./DatePicker";
import { Logo } from "./Logo";
import { signIn } from "@/lib/useSession";

/** The slice of a trip this page renders — page.tsx adapts both local
 *  trips and account summaries into this. */
export interface MobileLandingTrip {
  id: string;
  name: string;
  status: string;
  spotCount: number;
  videoCount: number;
  cover?: string | null;
}

export default function MobileLanding({
  authEnabled,
  profileSlot,
  myTrips,
  totalSpots,
  watchSaved,
  destination,
  setDestination,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  interests,
  setInterests,
  creating,
  error,
  onCreate,
  autoFocusDest,
}: {
  authEnabled: boolean;
  /** Signed-in avatar + menu (page.tsx owns the session UI); null when
   *  signed out — this component then shows a sign-in button. */
  profileSlot: ReactNode | null;
  myTrips: MobileLandingTrip[];
  totalSpots: number;
  watchSaved: { n: number; label: string } | null;
  destination: string;
  setDestination: (v: string) => void;
  startDate: string;
  setStartDate: (v: string) => void;
  endDate: string;
  setEndDate: (v: string) => void;
  interests: string;
  setInterests: (v: string) => void;
  creating: boolean;
  error: string;
  onCreate: () => void;
  autoFocusDest?: boolean;
}) {
  const [tripsOpen, setTripsOpen] = useState(false);
  const destRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusDest) destRef.current?.focus();
  }, [autoFocusDest]);

  const tileCovers = myTrips
    .map((t) => t.cover)
    .filter((c): c is string => Boolean(c))
    .slice(0, 3);

  return (
    <main className={`m-landing ${tripsOpen ? "trips-open" : ""}`}>
      {/* ---- Base: hero + trip form ---- */}
      <div className="ml-base" inert={tripsOpen}>
        <header className="ml-top">
          {profileSlot ??
            (authEnabled ? (
              <button
                className="ml-signin"
                onClick={() => signIn("/")}
                aria-label="Sign in"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="8.2" r="3.6" stroke="currentColor" strokeWidth="1.7" />
                  <path
                    d="M4.8 19.4c1.5-3 4.1-4.5 7.2-4.5s5.7 1.5 7.2 4.5"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : (
              <span />
            ))}
          {myTrips.length > 0 && (
            <button
              className="ml-trips-btn"
              onClick={() => setTripsOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={tripsOpen}
            >
              {tileCovers.length > 0 && (
                <span className="ml-covers" aria-hidden="true">
                  {tileCovers.map((c) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={c} src={c} alt="" />
                  ))}
                </span>
              )}
              <span className="ml-trips-label">
                Trips <span className="ml-trips-n">{myTrips.length}</span>
              </span>
            </button>
          )}
        </header>

        <section className="ml-hero">
          <Logo className="ml-brand" />
          {totalSpots > 0 && (
            <div className="ml-stat">
              <span className="ml-stat-dot" aria-hidden="true" />
              <strong>{totalSpots.toLocaleString()}</strong> spots pinned
              {watchSaved && (
                <>
                  <span className="ml-stat-sep" aria-hidden="true" />
                  <strong>{watchSaved.n}</strong> {watchSaved.label}
                </>
              )}
            </div>
          )}
          <h1>
            Every <span className="ml-yt">YouTube</span> travel guide, mapped
          </h1>
          <p className="ml-sub">
            We find the best videos, extract every recommendation, and build a
            map you can actually explore.
          </p>
        </section>

        <div className="ml-box">
          <label className="ml-row">
            <span className="ml-k">Where</span>
            <input
              ref={destRef}
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onCreate()}
              placeholder="Search destinations"
              disabled={creating}
            />
          </label>
          <div className="ml-row">
            <span className="ml-k">When</span>
            <div className="ml-dates">
              <DatePicker
                label=""
                value={startDate}
                onChange={setStartDate}
                disabled={creating}
                placeholder="Start"
              />
              <span className="ml-dates-sep" aria-hidden="true">
                –
              </span>
              <DatePicker
                label=""
                value={endDate}
                min={startDate || undefined}
                onChange={setEndDate}
                disabled={creating}
                placeholder="End"
              />
            </div>
          </div>
          <label className="ml-row">
            <span className="ml-k">Interests</span>
            <input
              type="text"
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onCreate()}
              placeholder="Surfing, street food…"
              disabled={creating}
            />
          </label>
          {error && <div className="ml-error">{error}</div>}
          <button className="ml-cta" onClick={onCreate} disabled={creating}>
            {creating ? "Searching…" : "Build my map"}
          </button>
        </div>
        <p className="ml-fine">
          Dates and interests are optional — they tune which videos we pick.
        </p>
      </div>

      {/* ---- Saved trips ---- */}
      <div
        className="ml-trips"
        role="dialog"
        aria-label="Your trips"
        inert={!tripsOpen}
      >
        <header className="ml-trips-head">
          <div>
            <h2>Trips</h2>
            <div className="ml-trips-meta">
              {myTrips.length} {myTrips.length === 1 ? "map" : "maps"} ·{" "}
              {myTrips.reduce((n, t) => n + t.spotCount, 0)} spots
            </div>
          </div>
          <button
            className="ml-close"
            onClick={() => setTripsOpen(false)}
            aria-label="Back"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="ml-cards">
          {myTrips.map((t, i) => (
            <Link
              key={t.id}
              href={`/trip/${t.id}`}
              className="ml-card"
              style={{ animationDelay: `${90 + i * 70}ms` }}
            >
              <span className="ml-card-photo">
                {t.cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.cover} alt="" />
                ) : (
                  <span className="ml-card-blank" aria-hidden="true" />
                )}
                {t.status === "processing" && (
                  <span className="ml-card-badge">
                    <span className="ml-building" /> Building
                  </span>
                )}
              </span>
              <span className="ml-card-name">{t.name}</span>
              <span className="ml-card-sub">
                {t.spotCount} spots · {t.videoCount} video
                {t.videoCount === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
          <button
            className="ml-new"
            style={{ animationDelay: `${90 + myTrips.length * 70}ms` }}
            onClick={() => {
              setTripsOpen(false);
              // Post-transition, so the focus doesn't fight the fade.
              setTimeout(() => destRef.current?.focus(), 350);
            }}
          >
            + New trip
          </button>
        </div>
      </div>
    </main>
  );
}
