"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { spotCoverUrl } from "@/lib/photoUrl";
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
// through the Google redirect, and resumes on the dashboard.
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

export default function Home() {
  const session = useSession();

  // Until we know who's asking, show just sky + nav — flashing the marketing
  // hero at a returning user (or the dashboard at a visitor) reads as a bug.
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

  if (session.enabled && session.user) return <Dashboard user={session.user} />;
  return <SignedOutLanding authEnabled={session.enabled} />;
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

/* ---------------- Signed-out landing (the original hero + gallery) -------- */

function SignedOutLanding({ authEnabled }: { authEnabled: boolean }) {
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
    // Trips belong to an account now: park the form, sign in with Google,
    // and the dashboard picks the build up the moment you're back.
    if (authEnabled) {
      stashPending({ destination, startDate, endDate, interests });
      setCreating(true);
      signIn("/");
      return;
    }
    setCreating(true);
    const id = startTrip({ destination, startDate, endDate, interests });
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
        {authEnabled && (
          <button className="nav-pill" onClick={() => signIn("/")}>
            Sign in
          </button>
        )}
      </nav>

      <section className="hero">
        {totalSpots > 0 && (
          <div className="stat-chip rise r1">
            <span className="stat-dot" />
            <strong>{totalSpots.toLocaleString()}</strong>spots pinned
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
          {authEnabled
            ? "You'll sign in with Google first — your trips stay yours, on any device."
            : "Dates and interests are optional — they tune which videos we pick."}
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
/* ---------------- Signed-in dashboard (app shell) ------------------------- */

interface DashTrip {
  id: string;
  name: string;
  status: string;
  spotCount: number;
  videoCount: number;
  plannedDays: number;
  startDate: string | null;
  endDate: string | null;
  cover: string | null;
  createdAt: string;
}

function summarizeTrip(t: Trip): DashTrip {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    spotCount: t.spots.length,
    videoCount: t.videos.length,
    plannedDays: t.itinerary?.days.length ?? 0,
    startDate: t.query?.startDate ?? null,
    endDate: t.query?.endDate ?? null,
    cover: (() => {
      const s = t.spots.find((sp) => sp.photo?.url || sp.mentions.length > 0);
      return s ? spotCoverUrl(s) : null;
    })(),
    createdAt: t.createdAt,
  };
}

function fmtDates(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const f = (iso: string, withYear: boolean) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });
  };
  return end && end !== start ? `${f(start, false)} – ${f(end, true)}` : f(start, true);
}

const PinIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path
      d="M11 20s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <circle cx="11" cy="9" r="2.5" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const GlobeIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="8.2" stroke="currentColor" strokeWidth="2" />
    <ellipse cx="11" cy="11" rx="3.6" ry="8.2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3.2 11h15.6" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/** Row thumbnail, falling back to the pin placeholder when there is no cover
 *  or its URL no longer resolves (photo links can expire). */
function RowThumb({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img className="dx-thumb" src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
    );
  }
  return (
    <div className="dx-thumb dx-thumb-empty" aria-hidden="true">
      <PinIcon size={14} />
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  if (status === "ready") return <span className="dx-chip ready">Ready</span>;
  if (status === "error") return <span className="dx-chip error">Failed</span>;
  return <span className="dx-chip building">Building…</span>;
}

/** The plan-a-new-trip form in a small centered modal. */
function NewTripModal({
  open,
  creating,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  creating: boolean;
  error: string;
  onClose: () => void;
  onCreate: (values: TripFormValues) => void;
}) {
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [interests, setInterests] = useState("");
  const destRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => destRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const submit = () => onCreate({ destination, startDate, endDate, interests });

  return (
    <div className="dx-modal-backdrop" onClick={onClose}>
      <div
        className="dx-modal"
        role="dialog"
        aria-label="Plan a new trip"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dx-modal-head">
          <h3>Plan a new trip</h3>
          <button className="dx-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="dx-modal-sub">
          We&rsquo;ll find the best YouTube guides and pin every place they rave
          about.
        </p>
        <div className="dx-field">
          <label htmlFor="dx-dest">Where</label>
          <input
            id="dx-dest"
            ref={destRef}
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Tbilisi, Georgia"
            disabled={creating}
          />
        </div>
        <div className="dx-field-row">
          <div className="dx-field">
            <DatePicker label="From" value={startDate} onChange={setStartDate} disabled={creating} />
          </div>
          <div className="dx-field">
            <DatePicker
              label="To"
              value={endDate}
              min={startDate || undefined}
              onChange={setEndDate}
              disabled={creating}
            />
          </div>
        </div>
        <div className="dx-field">
          <label htmlFor="dx-interests">Interests</label>
          <input
            id="dx-interests"
            type="text"
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="skiing, wine, street food…"
            disabled={creating}
          />
        </div>
        <button className="dx-primary dx-modal-cta" onClick={submit} disabled={creating}>
          {creating ? "Searching…" : "Build my map"}
        </button>
        {error && <div className="dx-modal-error">{error}</div>}
        <p className="dx-modal-fineprint">
          Dates and interests are optional — they tune which videos we pick.
        </p>
      </div>
    </div>
  );
}

function Dashboard({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [serverTrips, setServerTrips] = useState<TripSummary[]>([]);
  const [localTrips, setLocalTrips] = useState<Trip[]>([]);
  const [community, setCommunity] = useState<Trip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"mine" | "community">("mine");
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const refreshServer = useCallback(() => {
    fetch("/api/me/trips")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => Array.isArray(data) && setServerTrips(data))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const sync = () => setLocalTrips(listLocalTrips());
    sync();
    refreshServer();
    fetch("/api/trips")
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setCommunity(data))
      .catch(() => {});
    return subscribeLocalTrips(sync);
  }, [refreshServer]);

  // A form submitted before sign-in resumes here: create the trip and jump
  // straight into the building screen.
  useEffect(() => {
    const pending = takePending();
    if (!pending) return;
    const id = startTrip(pending, user.id);
    if (id) router.push(`/trip/${id}`);
  }, [user.id, router]);

  // Account trips merged with this browser's local copies — local wins (it's
  // the live, building copy; the account copy trails it by a debounce).
  const myTrips = useMemo(() => {
    const byId = new Map<string, DashTrip>();
    for (const t of serverTrips) byId.set(t.id, t);
    for (const t of localTrips) {
      if (!t.ownerId || t.ownerId === user.id) byId.set(t.id, summarizeTrip(t));
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [serverTrips, localTrips, user.id]);

  const communityTrips = useMemo(
    () =>
      community
        .map(summarizeTrip)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [community]
  );

  // Wispr-style stat cards: the number states the fact, the subtext makes it
  // mean something ("Next: Tbilisi in 51 days", "≈ 9h of watching saved").
  const stats = useMemo(() => {
    const trips = myTrips.length;
    const spots = myTrips.reduce((n, t) => n + t.spotCount, 0);
    const videos = myTrips.reduce((n, t) => n + t.videoCount, 0);
    const days = myTrips.reduce((n, t) => n + t.plannedDays, 0);

    const todayIso = new Date().toISOString().slice(0, 10);
    const next = myTrips
      .filter((t) => t.startDate && t.startDate >= todayIso)
      .sort((a, b) => a.startDate!.localeCompare(b.startDate!))[0];
    let tripsSub = "Where to first?";
    if (next) {
      const until = Math.round(
        (new Date(next.startDate! + "T00:00:00").getTime() -
          new Date(todayIso + "T00:00:00").getTime()) /
          86400000
      );
      const place = next.name.split(",")[0];
      tripsSub =
        until === 0
          ? `${place} starts today!`
          : until === 1
            ? `${place} starts tomorrow!`
            : `Next: ${place} in ${until} days`;
    } else if (trips > 0) {
      tripsSub = "All mapped — where next?";
    }

    const spotsSub =
      spots === 0
        ? "Your map is waiting"
        : `≈ ${Math.max(1, Math.round(spots / 8))} days of exploring`;

    // A travel guide runs ~20 minutes; reading the transcript takes seconds.
    const savedMin = videos * 20;
    const videosSub =
      videos === 0
        ? "We watch, you travel"
        : savedMin < 60
          ? `≈ ${savedMin} min of watching saved`
          : `≈ ${Math.round(savedMin / 60)}h of watching saved`;

    const plannedTrips = myTrips.filter((t) => t.plannedDays > 0).length;
    const daysSub =
      days === 0
        ? "The planner builds day one"
        : `Across ${plannedTrips} ${plannedTrips === 1 ? "itinerary" : "itineraries"}`;

    return { trips, spots, videos, days, tripsSub, spotsSub, videosSub, daysSub };
  }, [myTrips]);

  const shown = useMemo(() => {
    const list = view === "mine" ? myTrips : communityTrips;
    const q = query.trim().toLowerCase();
    return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  }, [view, myTrips, communityTrips, query]);

  function removeTrip(id: string) {
    deleteLocalTrip(id);
    setServerTrips((ts) => ts.filter((t) => t.id !== id));
    fetch(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
    try {
      localStorage.removeItem(`pinned.pushed.${id}`);
    } catch {}
  }

  function createTrip(values: TripFormValues) {
    setCreateError("");
    if (!values.destination.trim()) {
      setCreateError("Tell us where you're going.");
      return;
    }
    if (values.startDate && values.endDate && values.endDate < values.startDate) {
      setCreateError("The end date is before the start date.");
      return;
    }
    setCreating(true);
    const id = startTrip(values, user.id);
    if (!id) {
      setCreateError("Your browser storage is full — delete an old trip first.");
      setCreating(false);
      return;
    }
    router.push(`/trip/${id}`);
  }

  const firstName = user.name?.split(" ")[0] ?? null;
  const initial = (user.name ?? user.email)[0]?.toUpperCase() ?? "?";

  return (
    <main className="dx">
      {/* ----- Sidebar ----- */}
      <aside className="dx-side">
        <div className="dx-brand">
          <Logo className="brand" />
        </div>

        <button className="dx-primary dx-side-new" onClick={() => setModalOpen(true)}>
          <span className="dx-plus">+</span> Plan a new trip
        </button>

        <nav className="dx-nav">
          <button
            className={`dx-nav-item ${view === "mine" ? "on" : ""}`}
            onClick={() => setView("mine")}
          >
            <PinIcon />
            My trips
            {myTrips.length > 0 && <span className="dx-badge">{myTrips.length}</span>}
          </button>
          <button
            className={`dx-nav-item ${view === "community" ? "on" : ""}`}
            onClick={() => setView("community")}
          >
            <GlobeIcon />
            Community
            {communityTrips.length > 0 && (
              <span className="dx-badge">{communityTrips.length}</span>
            )}
          </button>
        </nav>

        <div className="dx-side-foot">
          <div className="dx-account">
            {user.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="dx-avatar" src={user.picture} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="dx-avatar dx-avatar-initial">{initial}</span>
            )}
            <div className="dx-account-who">
              <div className="dx-account-name">{user.name ?? "Signed in"}</div>
              <div className="dx-account-email">{user.email}</div>
            </div>
          </div>
          <button className="dx-signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      {/* ----- Main ----- */}
      <div className="dx-main">
        <header className="dx-head">
          <div>
            <h1>{firstName ? `Welcome back, ${firstName}` : "Welcome back"}</h1>
            <p className="dx-head-sub">Pick up where you left off, or start a new map.</p>
          </div>
        </header>

        <section className="dx-stats">
          <div className="dx-stat">
            <div className="dx-stat-n">{stats.trips}</div>
            <div className="dx-stat-label">{stats.trips === 1 ? "Trip" : "Trips"}</div>
            <div className="dx-stat-sub">{stats.tripsSub}</div>
          </div>
          <div className="dx-stat">
            <div className="dx-stat-n">{stats.spots.toLocaleString()}</div>
            <div className="dx-stat-label">Spots pinned</div>
            <div className="dx-stat-sub">{stats.spotsSub}</div>
          </div>
          <div className="dx-stat">
            <div className="dx-stat-n">{stats.videos}</div>
            <div className="dx-stat-label">Videos read</div>
            <div className="dx-stat-sub">{stats.videosSub}</div>
          </div>
          <div className="dx-stat">
            <div className="dx-stat-n">{stats.days}</div>
            <div className="dx-stat-label">Days planned</div>
            <div className="dx-stat-sub">{stats.daysSub}</div>
          </div>
        </section>

        <section className="dx-list">
          <div className="dx-list-head">
            <h2>{view === "mine" ? "My trips" : "Community trips"}</h2>
            <div className="dx-toolbar">
              <div className="dx-search">
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
                  <path d="M13.5 13.5L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={view === "mine" ? "Search my trips" : "Search community trips"}
                />
              </div>
              {view === "mine" && (
                <button className="dx-primary" onClick={() => setModalOpen(true)}>
                  <span className="dx-plus">+</span> New trip
                </button>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="dx-empty">
              {view === "community" ? (
                "No community trips match."
              ) : !loaded ? (
                "Loading your trips…"
              ) : query ? (
                "No trips match your search."
              ) : (
                <>
                  <div className="dx-empty-title">Plan your first trip</div>
                  <p>
                    Tell us where you&rsquo;re going — we&rsquo;ll watch the best
                    YouTube guides and pin every place they rave about.
                  </p>
                  <button className="dx-primary" onClick={() => setModalOpen(true)}>
                    <span className="dx-plus">+</span> Plan a new trip
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="dx-table-wrap">
              <table className="dx-table">
                <thead>
                  <tr>
                    <th>Trip</th>
                    <th>Dates</th>
                    <th className="num">Spots</th>
                    <th className="num">Videos</th>
                    <th>Plan</th>
                    <th>Status</th>
                    {view === "mine" && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id} onClick={() => router.push(`/trip/${t.id}`)}>
                      <td>
                        <div className="dx-trip-cell">
                          <RowThumb url={t.cover} />
                          <span className="dx-trip-name">{t.name}</span>
                        </div>
                      </td>
                      <td className="dim">{fmtDates(t.startDate, t.endDate) ?? "—"}</td>
                      <td className="num">{t.spotCount || "—"}</td>
                      <td className="num">{t.videoCount || "—"}</td>
                      <td className="dim">
                        {t.plannedDays > 0
                          ? `${t.plannedDays} day${t.plannedDays === 1 ? "" : "s"}`
                          : "Not planned"}
                      </td>
                      <td>
                        <StatusChip status={t.status} />
                      </td>
                      {view === "mine" && (
                        <td className="dx-actions">
                          <button
                            className="dx-row-del"
                            title="Delete this trip"
                            aria-label={`Delete ${t.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeTrip(t.id);
                            }}
                          >
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <NewTripModal
        open={modalOpen}
        creating={creating}
        error={createError}
        onClose={() => {
          if (!creating) {
            setModalOpen(false);
            setCreateError("");
          }
        }}
        onCreate={createTrip}
      />
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
        src={`/trip/${tripId}?embed=1`}
        title="Live trip demo"
        width={PREVIEW_W}
        height={PREVIEW_H}
        style={{ transform: `scale(${scale})` }}
      />
      <a className="preview-open" href={`/trip/${tripId}`}>
        Open full trip ↗
      </a>
    </div>
  );
}
