"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Mention, Spot, Trip } from "@/lib/types";
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
import { googlePhotoProxy } from "@/lib/photoUrl";

const HeroMap = dynamic(() => import("@/components/HeroMap"), { ssr: false });

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

  // The hero showcases the freshest ready trip — the most spots wins a tie so
  // the map always looks alive.
  const heroTrip = useMemo(
    () =>
      allTrips
        .filter((t) => t.status === "ready" && t.spots.length > 0)
        .sort((a, b) => b.spots.length - a.spots.length)[0] ?? null,
    [allTrips]
  );

  const heroSpots: Spot[] = useMemo(
    () =>
      heroTrip
        ? [...heroTrip.spots]
            .sort((a, b) => b.mentions.length - a.mentions.length)
            .slice(0, 10)
        : [],
    [heroTrip]
  );

  function removeTrip(id: string) {
    deleteLocalTrip(id); // no-op if it isn't a local trip
    void unpublishTrip(id); // remove from the shared library + owned set
  }

  const heroQuotes: Mention[] = useMemo(() => {
    if (!heroTrip) return [];
    return heroTrip.spots
      .flatMap((s) => s.mentions)
      .filter((m) => m.quote && m.quote.length > 30 && m.quote.length < 140 && m.channelAvatar)
      .slice(0, 12);
  }, [heroTrip]);

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

  function uniqueCreators(trip: Trip) {
    const seen = new Map<string, string>();
    for (const v of trip.videos) {
      if (v.channelName && !seen.has(v.channelName)) {
        seen.set(v.channelName, v.channelAvatar);
      }
    }
    return [...seen.entries()].slice(0, 4);
  }

  function tripCover(trip: Trip): string | null {
    const spot = trip.spots.find((s) => s.photo);
    if (spot?.photo) {
      // Google photo URLs expire — serve via the proxy keyed on the durable
      // placeId. Wikimedia photos are stable, so render those directly.
      if (spot.photo.source === "google" && spot.placeId) {
        return googlePhotoProxy(spot.placeId, 0);
      }
      return spot.photo.url;
    }
    return trip.videos[0]?.thumbnail ?? null;
  }

  function coverCard(t: Trip) {
    const cover = tripCover(t);
    const deletable = deletableIds.has(t.id);
    return (
      <a key={t.id} href={`/trip/${t.id}`} className="cover-card">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt={t.name} loading="lazy" />
        ) : (
          <div className="cover-fallback">🗺️</div>
        )}
        {/* ready needs no label; in-flight and failed builds still do */}
        {t.status !== "ready" && (
          <span className={`badge ${t.status} ${deletable ? "with-delete" : ""}`}>
            {t.status}
          </span>
        )}
        {deletable && (
          <button
            className="cover-delete"
            title="Delete this trip"
            aria-label={`Delete ${t.name}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              removeTrip(t.id);
            }}
          >
            <svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true">
              <path
                d="M1 3.5h11M5 1h3M2.5 3.5l.7 8.6a1 1 0 001 .9h4.6a1 1 0 001-.9l.7-8.6M5.2 6v4M7.8 6v4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <div className="cover-meta">
          <div className="cover-name">{t.name}</div>
          <div className="cover-sub">
            {t.videos.length} video{t.videos.length === 1 ? "" : "s"} ·{" "}
            {t.spots.length} spot{t.spots.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="cover-avatars">
          {uniqueCreators(t).map(([name, avatar]) =>
            avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={name} src={avatar} alt={name} title={name} />
            ) : null
          )}
        </div>
      </a>
    );
  }

  const hasTrips = allTrips.length > 0;

  return (
    <main className="landing">
      <section className="hero">
        <HeroMap spots={heroSpots} />
        <div className="hero-veil" />

        <nav className="hero-nav">
          <div className="brand">
            Pinned<span className="brand-dot">.</span>
          </div>
        </nav>

        <div className="hero-center">
          <h1>
            Every place they raved about.
            <br />
            On one map.
          </h1>
          <p className="hero-sub">
            Tell us where you&rsquo;re going. We find the best travel videos, read
            every word, and pin every spot creators actually recommend — with a
            link back to the exact moment each one comes up.
          </p>

          <div className="search-card">
            <div className="search-field grow">
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
            <div className="search-divider" />
            <div className="search-field">
              <label htmlFor="from">From</label>
              <input
                id="from"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={creating}
              />
            </div>
            <div className="search-divider" />
            <div className="search-field">
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
            <div className="search-divider" />
            <div className="search-field grow">
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
            <button className="btn-primary" onClick={createTrip} disabled={creating}>
              {creating ? "Searching…" : "Build my map"}
            </button>
          </div>
          {error && <div className="hero-error">{error}</div>}
          <div className="hero-hint">
            Dates and interests are optional — they tune which videos we pick.
          </div>
        </div>

        {heroQuotes.length > 0 && <QuoteField quotes={heroQuotes} />}

        {hasTrips && (
          <button
            className="scroll-hint"
            onClick={() =>
              document
                .querySelector(".trips-gallery")
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            <span className="hint-label">Trips</span>
            <svg width="16" height="9" viewBox="0 0 16 9" fill="none" aria-hidden="true">
              <path d="M1 1l7 6.5L15 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </section>

      {hasTrips && (
        <section className="trips-gallery">
          <div className="gallery-head">
            <h2>Trips</h2>
            <a className="upload-link" href="/uploadtrip">
              Upload a trip
            </a>
          </div>
          <div className="gallery-grid">{allTrips.map((t) => coverCard(t))}</div>
        </section>
      )}

      <footer className="landing-footer">
        Built from creators&rsquo; actual words — never sponsored lists.
      </footer>
    </main>
  );
}

// Quotes pop up along the hero's side gutters — real people vouching for real
// places — then drift away. They hug the screen edges; their width is capped
// in CSS to the gutter beside the content column, so they can never reach the
// headline or the paste bar.
const QUOTE_SLOTS: React.CSSProperties[] = [
  { left: 24, top: "10%" },
  { right: 24, top: "32%" },
  { left: 24, bottom: "24%" },
  { right: 24, bottom: "8%" },
  { left: 24, top: "40%" },
  { right: 24, top: "12%" },
];

const QUOTE_LIFE_MS = 7000;
const QUOTE_SPAWN_MS = 2800;

function QuoteField({ quotes }: { quotes: Mention[] }) {
  const [bubbles, setBubbles] = useState<
    { key: number; quote: Mention; slot: number }[]
  >([]);

  useEffect(() => {
    let key = 0;
    let qi = 0;
    let slot = 0;
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const spawn = () => {
      const bubble = {
        key: key++,
        quote: quotes[qi++ % quotes.length],
        slot: slot++ % QUOTE_SLOTS.length,
      };
      setBubbles((cur) => [...cur, bubble]);
      const t = setTimeout(() => {
        setBubbles((cur) => cur.filter((b) => b.key !== bubble.key));
        timeouts.delete(t);
      }, QUOTE_LIFE_MS);
      timeouts.add(t);
    };
    spawn();
    const interval = setInterval(spawn, QUOTE_SPAWN_MS);
    return () => {
      clearInterval(interval);
      timeouts.forEach(clearTimeout);
      setBubbles([]); // drop in-flight bubbles (StrictMode remount, quote change)
    };
  }, [quotes]);

  return (
    <>
      {bubbles.map((b) => (
        <div className="quote-bubble" style={QUOTE_SLOTS[b.slot]} key={b.key}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.quote.channelAvatar} alt={b.quote.channelName} />
          <div>
            <div className="q-text">&ldquo;{b.quote.quote}&rdquo;</div>
            <div className="q-name">{b.quote.channelName}</div>
          </div>
        </div>
      ))}
    </>
  );
}
