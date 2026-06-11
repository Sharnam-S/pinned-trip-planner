"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Spot, Trip, TripVideo } from "@/lib/types";
import { CATEGORY_EMOJI, formatTimestamp, youtubeLink } from "@/lib/categories";

const TripMap = dynamic(() => import("./TripMap"), { ssr: false });

const STATUS_ICON: Record<TripVideo["status"], string> = {
  pending: "⏳",
  processing: "⚙️",
  done: "✅",
  error: "⚠️",
};

function VideoStrip({ videos }: { videos: TripVideo[] }) {
  return (
    <div className="video-strip">
      {videos.map((v) => (
        <div className="video-chip" key={v.id} title={v.error ?? ""}>
          {v.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="thumb" src={v.thumbnail} alt="" />
          ) : (
            <div className="thumb" style={{ width: 52, height: 32 }} />
          )}
          <div className="vmeta">
            <div className="vtitle">{v.title || v.url}</div>
            <div className="vchannel">
              {v.channelName || "…"}
              {v.status === "done" && v.spotCount != null && ` · ${v.spotCount} spots`}
              {v.status === "error" && ` · ${v.error}`}
            </div>
          </div>
          <div className="vstatus">{STATUS_ICON[v.status]}</div>
        </div>
      ))}
    </div>
  );
}

export default function TripView({ tripId }: { tripId: string }) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addLinks, setAddLinks] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/trips/${tripId}`);
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    const data: Trip = await res.json();
    setTrip(data);
  }, [tripId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while processing so spots appear as each video finishes — and while
  // photo backfill is filling in Wikimedia images for older trips.
  const needsPoll =
    trip?.status === "processing" ||
    (trip?.status === "ready" && trip.spots.some((s) => s.photo === undefined));
  useEffect(() => {
    if (needsPoll && !pollRef.current) {
      pollRef.current = setInterval(load, 2500);
    }
    if (trip && !needsPoll && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [trip, needsPoll, load]);

  async function addVideos() {
    setAddError("");
    const urls = addLinks
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    setAdding(true);
    const res = await fetch(`/api/trips/${tripId}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const data = await res.json();
    setAdding(false);
    if (!res.ok) {
      setAddError(data.error ?? "Failed to add videos.");
      return;
    }
    setAddLinks("");
    load();
  }

  if (notFound) {
    return (
      <div className="processing-page">
        <h1>Trip not found</h1>
        <a className="back" href="/">← Back to trips</a>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="processing-page">
        <div className="spinner" />
      </div>
    );
  }

  // Full-page processing state until we have a destination + at least one spot.
  if (!trip.destination || (trip.status === "processing" && trip.spots.length === 0)) {
    return (
      <div className="processing-page">
        {trip.status === "processing" ? <div className="spinner" /> : null}
        <h1>{trip.status === "error" ? "Couldn't build this trip" : "Building your map…"}</h1>
        <div className="progress">{trip.progress}</div>
        <VideoStrip videos={trip.videos} />
        <a className="back" href="/">← Back to trips</a>
      </div>
    );
  }

  const selectedSpot = trip.spots.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="trip-page">
      <aside className="sidebar">
        <a className="back" href="/">← All trips</a>
        <h1>{trip.name}</h1>
        <div className="summary">
          {trip.spots.length} spots from {trip.videos.filter((v) => v.status === "done").length}{" "}
          video{trip.videos.length === 1 ? "" : "s"}
        </div>

        {trip.status === "processing" && (
          <div className="progress-banner">⚙️ {trip.progress}</div>
        )}

        <VideoStrip videos={trip.videos} />

        {trip.status !== "processing" && (
          <div className="add-videos">
            <textarea
              placeholder="Add more YouTube links…"
              value={addLinks}
              onChange={(e) => setAddLinks(e.target.value)}
            />
            {addError && <div className="error" style={{ color: "var(--accent)", fontSize: 13 }}>{addError}</div>}
            <button className="btn-secondary" onClick={addVideos} disabled={adding || !addLinks.trim()}>
              {adding ? "Adding…" : "Add videos"}
            </button>
          </div>
        )}

        <div className="spot-list">
          {[...trip.spots]
            .sort((a, b) => b.mentions.length - a.mentions.length || a.name.localeCompare(b.name))
            .map((spot) => (
              <button
                key={spot.id}
                className={`spot-row ${selectedId === spot.id ? "selected" : ""}`}
                onClick={() => setSelectedId(spot.id)}
              >
                <div className="emoji">{CATEGORY_EMOJI[spot.category]}</div>
                <div className="smeta">
                  <div className="sname">{spot.name}</div>
                  <div className="scat">
                    {spot.category}
                    {spot.mentions.length > 1 && ` · ${spot.mentions.length} creators`}
                  </div>
                </div>
                <div className="avatar-stack">
                  {spot.mentions.slice(0, 3).map((m) =>
                    m.channelAvatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={m.videoId} src={m.channelAvatar} alt={m.channelName} />
                    ) : null
                  )}
                </div>
              </button>
            ))}
        </div>
      </aside>

      <div className="map-wrap">
        <TripMap
          destination={trip.destination}
          spots={trip.spots}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        {selectedSpot && (
          <SpotCard spot={selectedSpot} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  );
}

function SpotCard({ spot, onClose }: { spot: Spot; onClose: () => void }) {
  // Wikimedia photo when we found one; otherwise a frame from the first
  // creator's video — there is always something to show
  const photoUrl =
    spot.photo?.url ??
    (spot.mentions[0]
      ? `https://i.ytimg.com/vi/${spot.mentions[0].videoId}/hqdefault.jpg`
      : null);

  return (
    <div className="spot-card">
      <button className="close" onClick={onClose} aria-label="Close">✕</button>
      {photoUrl && (
        <div className="card-photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt={spot.name} loading="lazy" />
          <span className="photo-credit">
            {spot.photo ? "📷 Wikimedia Commons" : `📺 ${spot.mentions[0]?.channelName ?? ""}`}
          </span>
        </div>
      )}
      <div className="card-body">
        <div className="cat-line">
          {CATEGORY_EMOJI[spot.category]} {spot.category}
          {spot.geocodeSource === "llm" && " · approximate location"}
        </div>
        <h2>{spot.name}</h2>
        <p className="desc">{spot.description}</p>

        {(spot.thingsToKnow?.length ?? 0) > 0 && (
          <div className="know-section">
            <div className="know-label">Things to know</div>
            {spot.thingsToKnow!.map((tip, i) => (
              <div className="know-item" key={i}>
                <span className="know-icon">⚠️</span>
                <span>{tip}</span>
              </div>
            ))}
          </div>
        )}

        <div className="rec-label">
          Recommended by{" "}
          {spot.mentions.length === 1
            ? spot.mentions[0].channelName
            : `${spot.mentions.length} creators`}
        </div>
        {spot.mentions.map((m) => (
          <a
            key={m.videoId}
            className="creator-row"
            href={youtubeLink(m.videoId, m.timestampSec)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open "${m.videoTitle}" at ${formatTimestamp(m.timestampSec)}`}
          >
            {m.channelAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.channelAvatar} alt={m.channelName} />
            ) : (
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#ddd" }} />
            )}
            <div className="cmeta">
              <div className="cname">{m.channelName}</div>
              <div className="cquote">&ldquo;{m.quote}&rdquo;</div>
            </div>
            <div className="play">▶ {formatTimestamp(m.timestampSec)}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
