"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Itinerary, Spot, SpotCategory, Trip, TripVideo } from "@/lib/types";
import { CATEGORY_EMOJI, formatTimestamp, youtubeLink } from "@/lib/categories";
import { getLocalTrip, saveLocalTrip, subscribeLocalTrips } from "@/lib/clientStore";
import { addVideosToTrip, ensureRunning, isRunning } from "@/lib/runner";
import { parseVideoId } from "@/lib/links";
import { googlePhotoProxy } from "@/lib/photoUrl";
import { dayColor, loadItinerary, unassignedSpotIds } from "@/lib/itinerary";
import BuildingScreen from "./BuildingScreen";
import PlannerChat from "./PlannerChat";
import type { MapBounds, PlanRender } from "./TripMap";

const TripMap = dynamic(() => import("./TripMap"), { ssr: false });

const STATUS_ICON: Record<TripVideo["status"], string> = {
  pending: "⏳",
  processing: "⚙️",
  done: "✅",
  error: "⚠️",
};

function VideoStrip({
  videos,
  pinnedId,
  onHoverVideo,
  onClickVideo,
}: {
  videos: TripVideo[];
  pinnedId?: string | null;
  onHoverVideo?: (id: string | null) => void;
  onClickVideo?: (id: string) => void;
}) {
  return (
    <div className="video-strip">
      {videos.map((v) => (
        <div
          className={`video-chip ${onClickVideo ? "interactive" : ""} ${
            pinnedId === v.id ? "pinned" : ""
          }`}
          key={v.id}
          title={v.error ?? ""}
          onMouseEnter={() => onHoverVideo?.(v.id)}
          onMouseLeave={() => onHoverVideo?.(null)}
          onClick={(e) => {
            if (!onClickVideo) return;
            e.stopPropagation();
            onClickVideo(v.id);
          }}
        >
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

function formatTripDates(trip: Trip): string | null {
  const { startDate, endDate } = trip.query ?? {};
  if (!startDate && !endDate) return null;
  const fmt = (iso: string) =>
    new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  if (startDate && endDate) return `${fmt(startDate)} – ${fmt(endDate)}`;
  return fmt((startDate ?? endDate)!);
}

function spotPhotoUrl(spot: Spot): string | null {
  // Wikimedia photo when we found one; otherwise a frame from the first
  // creator's video — there is always something to show
  return (
    spot.photo?.url ??
    (spot.mentions[0]
      ? `https://i.ytimg.com/vi/${spot.mentions[0].videoId}/hqdefault.jpg`
      : null)
  );
}

// Lazy photo carousel state, shared by the grid tiles and the detail card.
// Photos beyond the cover resolve on the first swipe — a card nobody swipes
// never bills the Photos API. Local trips persist the resolved URLs back to
// localStorage; sample trips keep them for this page view only.
function useSpotPhotos(spot: Spot, tripId: string, local: boolean) {
  // Google photo URLs expire, so serve the whole Google set through /api/photo
  // (keyed on the durable placeId + index) instead of the stored URLs. That
  // also lets us render every photo up front — no lazy re-fetch, no /api/photos
  // round-trip. Wikimedia / video-frame photos are stable and render directly.
  const isGooglePhotos =
    Boolean(spot.placeId) &&
    (spot.photo?.source === "google" ||
      (spot.photos?.some((p) => p.source === "google") ?? false) ||
      (spot.morePhotoNames?.length ?? 0) > 0);
  const googleCount =
    (spot.photos?.length ?? (spot.photo ? 1 : 0)) + (spot.morePhotoNames?.length ?? 0);

  const baseUrls = isGooglePhotos
    ? Array.from({ length: Math.max(googleCount, 1) }, (_, k) =>
        googlePhotoProxy(spot.placeId!, k)
      )
    : spot.photos && spot.photos.length > 0
      ? spot.photos.map((p) => p.url)
      : spotPhotoUrl(spot)
        ? [spotPhotoUrl(spot)!]
        : [];
  // Full resolved list once the lazy fetch lands (sample trips only — local
  // trips re-render off the localStorage update instead)
  const [allUrls, setAllUrls] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const fetchingRef = useRef(false);

  const urls = allUrls ?? baseUrls;
  // Google sets are already complete; only the legacy lazy path has pending.
  const pending = isGooglePhotos || allUrls ? 0 : (spot.morePhotoNames?.length ?? 0);
  const total = urls.length + pending;
  const i = Math.min(index, Math.max(0, total - 1));

  const ensureAll = () => {
    if (isGooglePhotos || allUrls || pending === 0 || fetchingRef.current) return;
    fetchingRef.current = true;
    fetch(`/api/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: spot.morePhotoNames }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { urls: string[] }) => {
        const seen = new Set(baseUrls);
        const extras = data.urls.filter((u) => !seen.has(u));
        setAllUrls([...baseUrls, ...extras]);
        if (local) {
          const trip = getLocalTrip(tripId);
          const s = trip?.spots.find((x) => x.id === spot.id);
          if (trip && s) {
            const have = new Set((s.photos ?? []).map((p) => p.url));
            s.photos = [
              ...(s.photos ?? []),
              ...extras
                .filter((u) => !have.has(u))
                .map((u) => ({ url: u, source: "google" as const })),
            ];
            s.morePhotoNames = undefined;
            saveLocalTrip(trip);
          }
        }
      })
      .catch(() => {
        fetchingRef.current = false; // allow retry on the next swipe
      });
  };

  const step = (e: React.MouseEvent, delta: number) => {
    e.stopPropagation(); // don't select the spot behind the arrow
    ensureAll();
    setIndex(Math.min(total - 1, Math.max(0, i + delta)));
  };

  return { urls, i, total, step };
}

function CarouselControls({
  i,
  total,
  step,
}: {
  i: number;
  total: number;
  step: (e: React.MouseEvent, delta: number) => void;
}) {
  if (total <= 1) return null;
  return (
    <>
      {i > 0 && (
        <span className="car-arrow left" onClick={(e) => step(e, -1)} aria-label="Previous photo">
          <svg width="9" height="14" viewBox="0 0 9 14" fill="none">
            <path d="M8 1L2 7l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
      {i < total - 1 && (
        <span className="car-arrow right" onClick={(e) => step(e, 1)} aria-label="Next photo">
          <svg width="9" height="14" viewBox="0 0 9 14" fill="none">
            <path d="M1 1l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
      <span className="car-dots">
        {Array.from({ length: total }, (_, d) => (
          <span key={d} className={`dot ${d === i ? "on" : ""}`} />
        ))}
      </span>
    </>
  );
}

// A carousel <img> that shimmers over the previous photo until the new source
// finishes loading. Without this the browser keeps painting the old image while
// the next one downloads, so a swipe looks like nothing happened. Caller keys
// this on `src` so the loaded state resets for each photo.
function CarouselImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        // A cached image can already be complete before onLoad is wired up.
        ref={(el) => {
          if (el?.complete) setLoaded(true);
        }}
      />
      {!loaded && <div className="car-shimmer" />}
    </>
  );
}

// Airbnb-style tile photo carousel: arrows appear on hover, dots track the
// current photo. Single-photo spots render a plain image.
function TilePhotos({ spot, tripId, local }: { spot: Spot; tripId: string; local: boolean }) {
  const { urls, i, total, step } = useSpotPhotos(spot, tripId, local);

  return (
    <div className="tile-photo">
      {urls[i] ? (
        <CarouselImage key={urls[i]} src={urls[i]} alt={spot.name} />
      ) : urls.length > 0 ? (
        <div className="tile-photo-loading" /> // swiped ahead of the lazy fetch
      ) : (
        <div className="tile-photo-fallback">{CATEGORY_EMOJI[spot.category]}</div>
      )}
      <span className="tile-cat">
        {CATEGORY_EMOJI[spot.category]} {spot.category}
      </span>
      <CarouselControls i={i} total={total} step={step} />
    </div>
  );
}

// Airbnb-style centered "search" pill for the trip header. Two segments: the
// place/trip name on the left, and a YouTube-videos selector on the right that
// drops down the source list (and the add-videos box for local trips).
function TripSearchPill({
  trip,
  canAdd,
  addLinks,
  setAddLinks,
  addError,
  onAddVideos,
  open,
  setOpen,
  pinnedId,
  onHoverVideo,
  onClickVideo,
}: {
  trip: Trip;
  canAdd: boolean;
  addLinks: string;
  setAddLinks: (v: string) => void;
  addError: string;
  onAddVideos: () => void;
  open: boolean;
  setOpen: (fn: (o: boolean) => boolean) => void;
  pinnedId: string | null;
  onHoverVideo: (id: string | null) => void;
  onClickVideo: (id: string) => void;
}) {
  const count = trip.videos.length;
  return (
    <div className="trip-pill-slot" onClick={(e) => e.stopPropagation()}>
      {/* One white card: the pill row on top, and the video list expanding
          inside the same container below it (Airbnb search-pill morph) */}
      <div className={`trip-pill ${open ? "open" : ""}`}>
        <div className="pill-row">
          <div className="pill-seg pill-place">
            <span className="pill-icon" aria-hidden="true">
              📍
            </span>
            <span className="pill-text">{trip.name}</span>
          </div>

          <span className="pill-sep" />

          <button
            className={`pill-seg pill-videos ${open ? "open" : ""}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="pill-thumbs">
              {trip.videos.slice(0, 3).map((v) =>
                v.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={v.id} src={v.thumbnail} alt="" />
                ) : null
              )}
            </span>
            <span className="pill-text">
              {count} video{count === 1 ? "" : "s"}
            </span>
            <span className={`pill-chevron ${open ? "open" : ""}`}>▾</span>
          </button>
        </div>

        <div className="videos-panel" inert={!open}>
          <div className="videos-panel-clip">
            <div className="videos-panel-body">
              <VideoStrip
                videos={trip.videos}
                pinnedId={pinnedId}
                onHoverVideo={onHoverVideo}
                onClickVideo={onClickVideo}
              />
              {canAdd && trip.status !== "processing" && (
                <div className="add-videos">
                  <textarea
                    placeholder="Add more YouTube links…"
                    value={addLinks}
                    onChange={(e) => setAddLinks(e.target.value)}
                  />
                  {addError && (
                    <div className="error" style={{ color: "var(--red)", fontSize: 13 }}>{addError}</div>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={onAddVideos}
                    disabled={!addLinks.trim()}
                  >
                    Add videos
                  </button>
                </div>
              )}
              {!canAdd && (
                <div className="hero-hint" style={{ padding: "8px 4px 2px" }}>
                  This is a sample trip — build your own from the homepage to add
                  videos.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Airbnb-style loading skeleton: a shimmering ghost of the real trip page so
// the header, spot grid, and map slot in place before the data lands.
function TripSkeleton({ embed = false }: { embed?: boolean }) {
  return (
    <div className="trip-page">
      {!embed && (
      <header className="page-header">
        <div className="header-bar">
          <a className="back" href="/">
            <span className="back-arrow" aria-hidden="true">←</span>
            Home
          </a>
          <div className="trip-pill-slot">
            <div className="trip-pill">
              <div className="pill-row">
                <div className="skeleton sk-pill-place" />
                <span className="pill-sep" />
                <div className="skeleton sk-pill-videos" />
              </div>
            </div>
          </div>
          <div className="skeleton sk-export" />
        </div>
        <div className="filter-bar">
          <div className="skeleton sk-count" />
          <div className="cat-filter">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="skeleton sk-chip" key={i} />
            ))}
          </div>
        </div>
      </header>
      )}

      <div className="trip-body">
        <section className="content-panel">
          <div className="spot-grid">
            {Array.from({ length: 9 }).map((_, i) => (
              <div className="spot-tile skeleton-tile" key={i}>
                <div className="tile-photo skeleton" />
                <div className="tile-meta">
                  <div className="skeleton sk-line title" />
                  <div className="skeleton sk-line sub" />
                  <div className="skeleton sk-line desc" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <div className="map-side">
          <div className="map-frame skeleton" />
        </div>
      </div>
    </div>
  );
}

// embed: the landing-page playground rendering — no trip-overview header
// (back button, search pill, filter chips), just the white cards + map body.
export default function TripView({
  tripId,
  embed = false,
}: {
  tripId: string;
  embed?: boolean;
}) {
  const [trip, setTrip] = useState<Trip | null>(null);
  // null = still checking localStorage; then the trip is local or a sample
  const [isLocal, setIsLocal] = useState<boolean | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bounds, setBounds] = useState<MapBounds | null>(null);
  // Hover previews a video's spots on the map; click pins the highlight until
  // the user clicks anywhere else.
  const [pinnedVideoId, setPinnedVideoId] = useState<string | null>(null);
  const [hoverVideoId, setHoverVideoId] = useState<string | null>(null);
  // The YouTube-videos dropdown in the header pill; closes on any outside click.
  const [videosOpen, setVideosOpen] = useState(false);
  const highlightVideoId = hoverVideoId ?? pinnedVideoId;
  const [addLinks, setAddLinks] = useState("");
  const [addError, setAddError] = useState("");
  // Full-width map: hides the spot grid, toggled from under the zoom control
  const [mapExpanded, setMapExpanded] = useState(false);
  // Category filter: empty = show all. Applies to both the grid and the map.
  const [activeCats, setActiveCats] = useState<SpotCategory[]>([]);
  // Planner agent: chat panel + the itinerary it maintains + map day filter.
  // The itinerary is derived from storage each render (localStorage is the
  // source of truth); the override covers the moment the agent saves, before
  // any store subscription fires (sample trips have none).
  // Open by default — planning is the page's second half, not a hidden mode.
  // (The embed playground stays map-first.)
  const [planOpen, setPlanOpen] = useState(!embed);
  const [itineraryOverride, setItineraryOverride] = useState<Itinerary | null>(null);
  const [activeDay, setActiveDay] = useState<PlanRender["activeDay"]>("all");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSample = useCallback(async () => {
    const res = await fetch(`/api/trips/${tripId}`);
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    const data: Trip = await res.json();
    setTrip(data);
  }, [tripId]);

  useEffect(() => {
    const local = getLocalTrip(tripId);
    if (local) {
      setIsLocal(true);
      setTrip(local);
      // resume an interrupted build (page refresh mid-processing)
      if (local.status === "processing" && !isRunning(tripId)) {
        ensureRunning(tripId);
      }
      return subscribeLocalTrips(() => {
        const t = getLocalTrip(tripId);
        if (t) setTrip(t);
      });
    }
    setIsLocal(false);
    loadSample();
  }, [tripId, loadSample]);

  // Local trips carry the plan on the Trip object; sample trips keep a
  // per-browser overlay. Freshest of the two wins.
  const itinerary =
    trip && isLocal !== null
      ? [itineraryOverride, loadItinerary(trip, isLocal)]
          .filter((x): x is Itinerary => x !== null)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
      : null;

  // Sample trips only: poll while local-dev background passes (photo
  // backfill, Google data upgrade) are improving them, so pins slide to
  // corrected positions live. Local trips re-render off store subscriptions.
  const needsPoll =
    isLocal === false &&
    trip?.status === "ready" &&
    (trip.upgrading === true || trip.spots.some((s) => s.photo === undefined));
  useEffect(() => {
    if (needsPoll && !pollRef.current) {
      pollRef.current = setInterval(loadSample, 2500);
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
  }, [trip, needsPoll, loadSample]);

  function addVideos() {
    setAddError("");
    const entries = addLinks
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((url) => ({ url, id: parseVideoId(url) }));
    if (entries.length === 0) return;
    const invalid = entries.filter((e) => !e.id);
    if (invalid.length > 0) {
      setAddError(`Not valid YouTube links: ${invalid.map((e) => e.url).join(", ")}`);
      return;
    }
    const unique = [...new Map(entries.map((e) => [e.id as string, e])).values()];
    const fresh = unique.filter((e) => !trip?.videos.some((v) => v.id === e.id));
    if (fresh.length === 0) {
      setAddError("Those videos are already in this trip.");
      return;
    }
    setAddLinks("");
    addVideosToTrip(tripId, fresh.map((e) => ({ id: e.id as string, url: e.url })));
  }

  if (notFound) {
    return (
      <div className="sky-page building-page">
        <div className="cloud-layer" aria-hidden="true">
          <div className="cloud c1" />
          <div className="cloud c2" />
          <div className="cloud c3" />
        </div>
        <div className="building-center">
          <h1 className="building-title">Trip not found</h1>
          <p className="building-sub">
            This trip isn&rsquo;t in the shared library or this browser — the
            link may be wrong, or it was deleted.
          </p>
          <a className="nav-pill" href="/">← Back to trips</a>
        </div>
      </div>
    );
  }

  if (!trip) {
    return <TripSkeleton embed={embed} />;
  }

  // Full-page building state until we have a destination + at least one spot.
  if (!trip.destination || (trip.status === "processing" && trip.spots.length === 0)) {
    return <BuildingScreen trip={trip} />;
  }

  // Categories present in this trip, most common first, with counts.
  const catCounts: [SpotCategory, number][] = (() => {
    const m = new Map<SpotCategory, number>();
    for (const s of trip.spots) m.set(s.category, (m.get(s.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();

  // Category filter feeds both the grid and the map pins.
  const activeSet = new Set(activeCats);
  const catFiltered =
    activeCats.length === 0
      ? trip.spots
      : trip.spots.filter((s) => activeSet.has(s.category));

  const selectedSpot = catFiltered.find((s) => s.id === selectedId) ?? null;

  const sortedSpots = [...catFiltered].sort(
    (a, b) => b.mentions.length - a.mentions.length || a.name.localeCompare(b.name)
  );
  const visibleSpots = bounds
    ? sortedSpots.filter(
        (s) =>
          s.lat <= bounds.north &&
          s.lat >= bounds.south &&
          s.lng >= bounds.west &&
          s.lng <= bounds.east
      )
    : sortedSpots;

  // Resolve the itinerary to drawable days (skip ids that no longer exist).
  const spotById = new Map(trip.spots.map((s) => [s.id, s]));
  const planRender: PlanRender | null =
    itinerary && itinerary.days.length > 0
      ? {
          days: itinerary.days.map((d, i) => ({
            label: d.label,
            color: dayColor(i),
            stops: d.stops.flatMap((st) => {
              const spot = spotById.get(st.spotId);
              return spot ? [{ spot, note: st.note }] : [];
            }),
          })),
          stay: itinerary.stay ?? null,
          activeDay,
        }
      : null;
  const unassignedCount = itinerary
    ? unassignedSpotIds(itinerary, trip.spots).length
    : 0;

  return (
    // Clicking anywhere outside the pill clears the pinned highlight and closes
    // the videos dropdown
    <div
      className="trip-page"
      onClick={() => {
        setPinnedVideoId(null);
        setVideosOpen(false);
      }}
    >
      {!embed && (
      <header className="page-header">
        <div className="header-bar">
          <a className="back" href="/">
            <span className="back-arrow" aria-hidden="true">←</span>
            Home
          </a>

          <TripSearchPill
            trip={trip}
            canAdd={isLocal === true}
            addLinks={addLinks}
            setAddLinks={setAddLinks}
            addError={addError}
            onAddVideos={addVideos}
            open={videosOpen}
            setOpen={(fn) => setVideosOpen((o) => fn(o))}
            pinnedId={pinnedVideoId}
            onHoverVideo={setHoverVideoId}
            onClickVideo={(id) =>
              setPinnedVideoId((cur) => (cur === id ? null : id))
            }
          />

        </div>

        <div className="filter-bar">
          <div className="filter-count">
            {visibleSpots.length === catFiltered.length
              ? `${catFiltered.length} spots`
              : `${visibleSpots.length} of ${catFiltered.length} spots`}
            {formatTripDates(trip) && ` · ${formatTripDates(trip)}`}
            {trip.query?.interests && ` · ${trip.query.interests}`}
          </div>

          {catCounts.length > 1 && (
            <div className="cat-filter">
              {catCounts.map(([cat, n]) => {
                const on = activeCats.includes(cat);
                return (
                  <button
                    key={cat}
                    className={`cat-chip ${on ? "on" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveCats((prev) =>
                        prev.includes(cat)
                          ? prev.filter((c) => c !== cat)
                          : [...prev, cat]
                      );
                    }}
                  >
                    {cat}
                    <span className="cat-n">{n}</span>
                  </button>
                );
              })}
              {activeCats.length > 0 && (
                <button
                  className="cat-clear"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveCats([]);
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>

        {trip.status === "processing" && (
          <div className="progress-banner-row">
            <div className="progress-banner">⚙️ {trip.progress}</div>
          </div>
        )}
      </header>
      )}

      <div
        className={`trip-body ${mapExpanded ? "map-expanded" : ""} ${
          planOpen ? "plan-open" : ""
        }`}
      >
        {planOpen ? (
          <PlannerChat
            trip={trip}
            isLocal={isLocal === true}
            itinerary={itinerary}
            onItineraryChange={setItineraryOverride}
            onClose={() => setPlanOpen(false)}
          />
        ) : (
          !embed && (
            <button
              className="planner-reopen"
              onClick={(e) => {
                e.stopPropagation();
                setPlanOpen(true);
              }}
              title="Open the planner"
              aria-label="Open the planner"
            >
              ✨
            </button>
          )
        )}
        <section className="content-panel">
          {visibleSpots.length === 0 ? (
            <div className="empty-area">
              No spots in this part of the map — zoom out or pan around to see more.
            </div>
          ) : (
          <div className="spot-grid">
            {visibleSpots.map((spot) => {
              return (
                <button
                  key={spot.id}
                  className={`spot-tile ${selectedId === spot.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(spot.id)}
                >
                  <TilePhotos spot={spot} tripId={trip.id} local={isLocal === true} />
                  <div className="tile-meta">
                    <div className="tile-name">{spot.name}</div>
                    <div className="tile-sub">
                      {spot.mentions.length === 1
                        ? spot.mentions[0].channelName
                        : `${spot.mentions.length} creators recommend`}
                    </div>
                    <div className="tile-desc">{spot.description}</div>
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
              );
            })}
          </div>
        )}
      </section>

        <div className="map-side">
          <div className="map-frame">
            <TripMap
              destination={trip.destination}
              spots={catFiltered}
              selectedId={selectedId}
              highlightVideoId={highlightVideoId}
              fitVideoId={highlightVideoId}
              plan={planRender}
              onSelect={setSelectedId}
              onBoundsChange={setBounds}
            />
            {planRender && (
              <div className="day-chips" onClick={(e) => e.stopPropagation()}>
                <button
                  className={`day-chip ${activeDay === "all" ? "on" : ""}`}
                  onClick={() => setActiveDay("all")}
                >
                  All days
                </button>
                {planRender.days.map((d, i) => (
                  <button
                    key={i}
                    className={`day-chip ${activeDay === i ? "on" : ""}`}
                    onClick={() =>
                      setActiveDay((cur) => (cur === i ? "all" : i))
                    }
                  >
                    <span className="dot" style={{ background: d.color }} />
                    {d.label}
                  </button>
                ))}
                {unassignedCount > 0 && (
                  <button
                    className={`day-chip ${
                      activeDay === "unassigned" ? "on" : ""
                    }`}
                    onClick={() =>
                      setActiveDay((cur) =>
                        cur === "unassigned" ? "all" : "unassigned"
                      )
                    }
                  >
                    Unassigned <span className="chip-n">{unassignedCount}</span>
                  </button>
                )}
              </div>
            )}
            <button
              className="map-expand-btn"
              onClick={() => setMapExpanded((x) => !x)}
              title={mapExpanded ? "Show the spot list" : "Expand the map"}
              aria-label={mapExpanded ? "Show the spot list" : "Expand the map"}
            >
              {mapExpanded ? (
                // arrows pointing in — collapse back to the split view
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6.5 1.5v5h-5M9.5 14.5v-5h5M6.5 6.5L1 1M9.5 9.5L15 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                // arrows pointing out — go full width
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M9.5 1.5h5v5M6.5 14.5h-5v-5M14.5 1.5L9 7M1.5 14.5L7 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            {selectedSpot && (
              <SpotCard
                key={selectedSpot.id} // remount per spot — photo carousel state must not leak between spots
                spot={selectedSpot}
                tripId={trip.id}
                local={isLocal === true}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SpotCard({
  spot,
  tripId,
  local,
  onClose,
}: {
  spot: Spot;
  tripId: string;
  local: boolean;
  onClose: () => void;
}) {
  const { urls, i, total, step } = useSpotPhotos(spot, tripId, local);
  // Google photo sets are all-Google; otherwise it's the single legacy photo
  // (wikimedia) or a frame from the recommending creator's video
  const credit =
    spot.photos && spot.photos.length > 0
      ? "📷 Google Maps"
      : spot.photo
        ? spot.photo.source === "google"
          ? "📷 Google Maps"
          : "📷 Wikimedia Commons"
        : `📺 ${spot.mentions[0]?.channelName ?? ""}`;

  return (
    <div className="spot-card">
      <button className="close" onClick={onClose} aria-label="Close">✕</button>
      {urls.length > 0 && (
        <div className="card-photo">
          {urls[i] ? (
            <CarouselImage key={urls[i]} src={urls[i]} alt={spot.name} />
          ) : (
            <div className="tile-photo-loading" />
          )}
          <span className="photo-credit">{credit}</span>
          <CarouselControls i={i} total={total} step={step} />
        </div>
      )}
      <div className="card-body">
        <div className="cat-line">
          {CATEGORY_EMOJI[spot.category]} {spot.category}
          {spot.geocodeSource === "llm" && " · approximate location"}
        </div>
        <h2>{spot.name}</h2>
        <p className="desc">{spot.description}</p>

        <a
          className="gmaps-btn"
          // Official Maps URL scheme — free, no API call. With a placeId it
          // opens the actual place page (reviews, hours, directions); without
          // one it falls back to a coordinate search.
          href={
            typeof spot.placeId === "string"
              ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  spot.name
                )}&query_place_id=${spot.placeId}`
              : `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="2" />
          </svg>
          Open in Google Maps
        </a>

        {(spot.thingsToKnow?.length ?? 0) > 0 && (
          <div className="know-section">
            <div className="know-label">Things to know</div>
            {spot.thingsToKnow!.map((tip, i) => (
              <div className="know-item" key={i}>
                <span className="know-icon" aria-hidden="true" />
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
