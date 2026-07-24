"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
import { SessionUser, signIn, signOut, useSession } from "@/lib/useSession";
import type { TripSummary } from "@/lib/db";
import DatePicker from "@/components/DatePicker";
import { Logo } from "@/components/Logo";

// The preview iframe renders the trip page at a fixed desktop size, then
// scales it down to fit its frame. ?embed=1 drops the trip-overview header
// so the preview starts right at the white cards + map body.
const PREVIEW_W = 1600;
const PREVIEW_H = 1000;

// A "Build my map" submitted while signed out parks the form here, rides
// through the Google redirect, and resumes on return.
const PENDING_KEY = "pinned.pending-trip";

interface TripFormValues {
  destination: string;
  startDate: string;
  endDate: string;
  interests: string;
}

function stashPending(values: TripFormValues) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(values));
  } catch {
    // storage full — the user just retypes after sign-in
  }
}

function takePending(): TripFormValues | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw) as TripFormValues;
  } catch {
    return null;
  }
}

/** Creates the local trip, kicks off the build, returns the new id. */
function startTrip(values: TripFormValues, ownerId?: string): string | null {
  const id = newTripId();
  const trip = newSearchTrip(id, {
    destination: values.destination.trim(),
    startDate: values.startDate || undefined,
    endDate: values.endDate || undefined,
    interests: values.interests.trim() || undefined,
  });
  if (ownerId) trip.ownerId = ownerId;
  if (!saveLocalTrip(trip)) return null;
  ensureRunning(id);
  return id;
}

/** What the trips rail + stat chip need — light, works for both a full local
 *  Trip and an account TripSummary. */
interface RailTrip {
  id: string;
  name: string;
  status: string;
  spotCount: number;
  videoCount: number;
  createdAt: string;
}

function railFromTrip(t: Trip): RailTrip {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    spotCount: t.spots.length,
    videoCount: t.videos.length,
    createdAt: t.createdAt,
  };
}

export default function Home() {
  const session = useSession();

  // Until we know who's asking, show just sky + nav — flashing the wrong nav
  // state at a returning user reads as a bug.
  if (session.loading) {
    return (
      <main className="landing">
        <CloudLayer />
        <nav className="top-nav">
          <Logo className="brand" />
        </nav>
      </main>
    );
  }

  return <Landing authEnabled={session.enabled} user={session.user} />;
}

function CloudLayer() {
  return (
    <div className="cloud-layer" aria-hidden="true">
      <div className="cloud c1" />
      <div className="cloud c2" />
      <div className="cloud c3" />
    </div>
  );
}

/** The signed-in avatar chip in the top nav: who you are + sign out. */
function ProfileButton({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const initial = (user.name ?? user.email)[0]?.toUpperCase() ?? "?";

  return (
    <div className="profile" ref={rootRef}>
      <button
        className="profile-chip"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
      >
        {user.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="profile-avatar"
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="profile-avatar profile-initial">{initial}</span>
        )}
      </button>
      {open && (
        <div className="profile-pop" role="menu">
          <div className="profile-who">
            <div className="profile-name">{user.name ?? "Signed in"}</div>
            <div className="profile-email">{user.email}</div>
          </div>
          <button
            className="profile-signout"
            role="menuitem"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Landing({
  authEnabled,
  user,
}: {
  authEnabled: boolean;
  user: SessionUser | null;
}) {
  const router = useRouter();
  const [localTrips, setLocalTrips] = useState<Trip[]>([]);
  const [shared, setShared] = useState<Trip[]>([]);
  const [serverTrips, setServerTrips] = useState<TripSummary[]>([]);
  const [ownedIds, setOwnedIds] = useState<string[]>([]);
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [interests, setInterests] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  // Set = the delete-confirmation dialog is open for this trip.
  const [confirmDelete, setConfirmDelete] = useState<RailTrip | null>(null);
  // ?start=1 (the planner panel's "Create your first trip" nudge) lands the
  // user ready to type: destination focused, search bar pulsing once.
  const destRef = useRef<HTMLInputElement>(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    const start = params.get("start") === "1";
    if (!authError && !start) return;
    window.history.replaceState(null, "", "/");
    // Post-paint: the ring animation runs its two beats and ends on its own,
    // so the class never needs un-setting.
    const t = setTimeout(() => {
      if (authError) setError(authError);
      if (start) {
        destRef.current?.focus();
        setPulse(true);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const sync = () => {
      setLocalTrips(listLocalTrips());
      setOwnedIds(readOwnedIds());
    };
    sync();
    const unsub = subscribeLocalTrips(sync);
    if (user) {
      // Signed in: the section below shows YOUR trips, from the account.
      fetch("/api/me/trips")
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => Array.isArray(data) && setServerTrips(data))
        .catch(() => {});
    } else {
      // Signed out: the shared library — repo samples + published trips.
      fetch("/api/trips")
        .then((r) => r.json())
        .then((data) => Array.isArray(data) && setShared(data))
        .catch(() => {});
    }
    return unsub;
  }, [user]);

  // A form submitted before sign-in resumes here: create the trip and jump
  // straight into the building screen.
  useEffect(() => {
    if (!user) return;
    const pending = takePending();
    if (!pending) return;
    const id = startTrip(pending, user.id);
    if (id) router.push(`/trip/${id}`);
  }, [user, router]);

  // The trips rail: signed in = your account trips merged with this browser's
  // local copies (local wins — it's the live, building copy); signed out =
  // your local trips merged over the shared library.
  const railTrips = useMemo(() => {
    const byId = new Map<string, RailTrip>();
    if (user) {
      for (const t of serverTrips) byId.set(t.id, t);
      for (const t of localTrips) {
        if (!t.ownerId || t.ownerId === user.id) byId.set(t.id, railFromTrip(t));
      }
    } else {
      for (const t of shared) byId.set(t.id, railFromTrip(t));
      for (const t of localTrips) byId.set(t.id, railFromTrip(t));
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [user, serverTrips, shared, localTrips]);

  // Trips this visitor may delete: signed in, everything here is yours;
  // signed out, anything this browser created locally or published.
  const deletableIds = useMemo(() => {
    if (user) return new Set(railTrips.map((t) => t.id));
    const s = new Set(ownedIds);
    for (const t of localTrips) s.add(t.id);
    return s;
  }, [user, railTrips, ownedIds, localTrips]);

  const totalSpots = useMemo(
    () => railTrips.reduce((n, t) => n + t.spotCount, 0),
    [railTrips]
  );

  // ~20 minutes of footage per travel guide, read for you in seconds.
  const watchSaved = useMemo(() => {
    const min = railTrips.reduce((n, t) => n + t.videoCount, 0) * 20;
    if (min <= 0) return null;
    if (min < 60) return { n: min, label: "min saved" };
    const h = Math.round(min / 60);
    return { n: h, label: h === 1 ? "hour saved" : "hours saved" };
  }, [railTrips]);

  const selectedTrip = useMemo(
    () =>
      railTrips.find((t) => t.id === selectedTripId) ??
      railTrips.find((t) => t.status === "ready" && t.spotCount > 0) ??
      railTrips[0] ??
      null,
    [railTrips, selectedTripId]
  );

  function removeTrip(id: string) {
    deleteLocalTrip(id); // no-op if it isn't a local trip
    if (user) {
      setServerTrips((ts) => ts.filter((t) => t.id !== id));
      fetch(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
      try {
        localStorage.removeItem(`pinned.pushed.${id}`);
      } catch {}
    } else {
      void unpublishTrip(id); // remove from the shared library + owned set
    }
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
    // Trips belong to an account: signed out, park the form, sign in with
    // Google, and the build picks up the moment you're back.
    if (authEnabled && !user) {
      stashPending({ destination, startDate, endDate, interests });
      setCreating(true);
      signIn("/");
      return;
    }
    setCreating(true);
    const id = startTrip({ destination, startDate, endDate, interests }, user?.id);
    if (!id) {
      setError("Your browser storage is full — delete an old trip first.");
      setCreating(false);
      return;
    }
    router.push(`/trip/${id}`);
  }

  return (
    <main className="landing">
      <CloudLayer />

      <nav className="top-nav">
        <Logo className="brand" />
        {user ? (
          <ProfileButton user={user} />
        ) : (
          authEnabled && (
            <button className="nav-pill" onClick={() => signIn("/")}>
              Sign in
            </button>
          )
        )}
      </nav>

      <section className="hero">
        {totalSpots > 0 && (
          <div className="stat-chip rise r1">
            <span className="stat-dot" />
            <strong>{totalSpots.toLocaleString()}</strong>spots pinned
            {watchSaved && (
              <>
                <span className="stat-sep" aria-hidden="true" />
                <strong>{watchSaved.n}</strong>
                {watchSaved.label}
              </>
            )}
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

        <div className={`search-bar rise r2${pulse ? " pulse" : ""}`}>
          <div className="sb-field grow">
            <label htmlFor="dest">Where</label>
            <input
              id="dest"
              ref={destRef}
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
            <DatePicker
              label="From"
              value={startDate}
              onChange={setStartDate}
              disabled={creating}
            />
          </div>
          <div className="sb-divider" />
          <div className="sb-field">
            <DatePicker
              label="To"
              value={endDate}
              min={startDate || undefined}
              onChange={setEndDate}
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
              <div className="rail-label">{user ? "Your trips" : "Trips"}</div>
              {railTrips.map((t) => (
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
                  <Link
                    className="rail-open"
                    title="Open full trip"
                    aria-label={`Open ${t.name}`}
                    href={`/trip/${t.id}`}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="M3 1.5h7.5V9M10.5 1.5L1.5 10.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Link>
                  {deletableIds.has(t.id) && (
                    <button
                      className="rail-del"
                      title="Delete this trip"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => setConfirmDelete(t)}
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

      {confirmDelete && (
        <ConfirmDelete
          trip={confirmDelete}
          signedIn={Boolean(user)}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            removeTrip(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}
    </main>
  );
}

/** "Are you sure?" dialog for trip deletion — a mis-click here would throw
 *  away a built map and its plan, so deletion is never one click. */
function ConfirmDelete({
  trip,
  signedIn,
  onCancel,
  onConfirm,
}: {
  trip: RailTrip;
  signedIn: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-card"
        role="alertdialog"
        aria-label={`Delete ${trip.name}?`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Delete &ldquo;{trip.name}&rdquo;?</h3>
        <p>
          {trip.spotCount > 0
            ? `The map, its ${trip.spotCount} pinned spot${trip.spotCount === 1 ? "" : "s"}, and any plan go with it. `
            : "The trip and anything in it go with it. "}
          {signedIn
            ? "It's removed from your account on every device — this can't be undone."
            : "This can't be undone."}
        </p>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>
            Keep trip
          </button>
          <button className="confirm-delete" onClick={onConfirm}>
            Delete trip
          </button>
        </div>
      </div>
    </div>
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
        src={`/trip/${tripId}?embed=1`}
        title="Live trip demo"
        width={PREVIEW_W}
        height={PREVIEW_H}
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
}
