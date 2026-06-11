"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trip } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [links, setLinks] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/trips")
      .then((r) => r.json())
      .then(setTrips)
      .catch(() => {});
  }, []);

  async function createTrip() {
    setError("");
    const urls = links
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      setError("Paste at least one YouTube link.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
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
    return [...seen.entries()].slice(0, 5);
  }

  return (
    <main className="home">
      <h1>🗺️ Trip planner, powered by YouTube</h1>
      <p className="tagline">
        Paste the YouTube videos where you found the good spots. We read the
        transcripts, pull out every place the creators actually recommend, and pin
        them all on one map — with links back to the exact moment in each video.
      </p>

      <section className="new-trip">
        <h2>Start a new trip</h2>
        <p>One YouTube link per line (4–5 videos about the same destination works best).</p>
        <textarea
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder={"https://www.youtube.com/watch?v=...\nhttps://youtu.be/..."}
          disabled={creating}
        />
        {error && <div className="error">{error}</div>}
        <button className="btn-primary" onClick={createTrip} disabled={creating}>
          {creating ? "Creating trip…" : "Build my map"}
        </button>
      </section>

      {trips.length > 0 && (
        <section className="trips-section">
          <h2>Your trips</h2>
          {trips.map((t) => (
            <a key={t.id} href={`/trip/${t.id}`}>
              <div className="trip-card">
                <div className="meta">
                  <div className="name">{t.name}</div>
                  <div className="sub">
                    {t.videos.length} video{t.videos.length === 1 ? "" : "s"} ·{" "}
                    {t.spots.length} spot{t.spots.length === 1 ? "" : "s"} ·{" "}
                    {new Date(t.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="avatars">
                    {uniqueCreators(t).map(([name, avatar]) =>
                      avatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={name} src={avatar} alt={name} title={name} />
                      ) : null
                    )}
                  </div>
                  <span className={`badge ${t.status}`}>{t.status}</span>
                </div>
              </div>
            </a>
          ))}
        </section>
      )}
    </main>
  );
}
