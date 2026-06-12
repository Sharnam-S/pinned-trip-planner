"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Mention, Spot, Trip } from "@/lib/types";

const HeroMap = dynamic(() => import("@/components/HeroMap"), { ssr: false });

export default function Home() {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [interests, setInterests] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/trips")
      .then((r) => r.json())
      .then(setTrips)
      .catch(() => {});
  }, []);

  // The hero showcases the user's freshest ready trip — the most spots wins
  // a tie so the map always looks alive.
  const heroTrip = useMemo(
    () =>
      trips
        .filter((t) => t.status === "ready" && t.spots.length > 0)
        .sort((a, b) => b.spots.length - a.spots.length)[0] ?? null,
    [trips]
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

  const heroQuotes: Mention[] = useMemo(() => {
    if (!heroTrip) return [];
    return heroTrip.spots
      .flatMap((s) => s.mentions)
      .filter((m) => m.quote && m.quote.length > 30 && m.quote.length < 140 && m.channelAvatar)
      .slice(0, 12);
  }, [heroTrip]);

  async function createTrip() {
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
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination, startDate, endDate, interests }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setCreating(false);
        return;
      }
      router.push(`/trip/${data.id}`);
    } catch {
      setError("Network error — is the dev server running?");
      setCreating(false);
    }
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
    return (
      trip.spots.find((s) => s.photo)?.photo?.url ??
      trip.videos[0]?.thumbnail ??
      null
    );
  }

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

        {trips.length > 0 && (
          <button
            className="scroll-hint"
            onClick={() =>
              document
                .querySelector(".trips-gallery")
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            <span className="hint-label">Your trips</span>
            <svg width="16" height="9" viewBox="0 0 16 9" fill="none" aria-hidden="true">
              <path d="M1 1l7 6.5L15 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </section>

      {trips.length > 0 && (
        <section className="trips-gallery">
          <h2>Your trips</h2>
          <div className="gallery-grid">
            {trips.map((t) => {
              const cover = tripCover(t);
              return (
                <a key={t.id} href={`/trip/${t.id}`} className="cover-card">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={cover} alt={t.name} loading="lazy" />
                  ) : (
                    <div className="cover-fallback">🗺️</div>
                  )}
                  <span className={`badge ${t.status}`}>{t.status}</span>
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
            })}
          </div>
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
