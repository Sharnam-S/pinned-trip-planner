"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Itinerary,
  ItineraryDay,
  ItineraryStop,
  Spot,
  SpotCategory,
  Trip,
  TripVideo,
} from "@/lib/types";
import { CATEGORY_EMOJI, formatTimestamp, youtubeLink } from "@/lib/categories";
import { getLocalTrip, saveLocalTrip, subscribeLocalTrips } from "@/lib/clientStore";
import { addVideosToTrip, ensureRunning, isRunning } from "@/lib/runner";
import { parseVideoId } from "@/lib/links";
import { googlePhotoProxy, spotCoverUrl, spotPhotoUrl } from "@/lib/photoUrl";
import {
  dayColor,
  haversineKm,
  loadItinerary,
  loadMustSees,
  saveMustSees,
  travelEstimate,
} from "@/lib/itinerary";
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

// --- Monochrome line icons for the spot card (stroke-2, round caps — the
// same language as the carousel chevrons). Colored by currentColor. ---

function IconCamera() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M9 7l1.6-2.6h2.8L15 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function IconVideo() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M10.5 9.3l4.6 2.7-4.6 2.7z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.6l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 3.6z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 1.3l6 3.7-6 3.7z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
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

// The trip's identity block at the top of the left rail: name + meta line,
// with the YouTube-videos list (and add-videos box) expanding below it.
function TripHead({
  trip,
  meta,
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
  meta: string;
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
    <div
      className={`trip-head ${open ? "open" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="th-row">
        <div className="th-id">
          <h1 className="th-name">{trip.name}</h1>
          <div className="th-meta">{meta}</div>
        </div>
        <button
          className={`th-videos ${open ? "open" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={`${count} source video${count === 1 ? "" : "s"}`}
        >
          <span className="pill-thumbs">
            {trip.videos.slice(0, 3).map((v) =>
              v.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={v.id} src={v.thumbnail} alt="" />
              ) : null
            )}
          </span>
          <span className="th-videos-n">{count}</span>
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
  );
}

// Airbnb-style loading skeleton: a shimmering ghost of the real trip page so
// the left rail, map, and right grid slot in place before the data lands.
function TripSkeleton({ embed = false }: { embed?: boolean }) {
  return (
    <div className="trip-page">
      <div className="trip-body">
        {!embed && (
          <aside className="left-side">
            <div className="trip-head">
              <div className="th-row">
                <div className="th-id">
                  <div className="skeleton sk-line title" style={{ width: 140 }} />
                  <div className="skeleton sk-line sub" style={{ width: 180 }} />
                </div>
                <div className="skeleton sk-pill-videos" />
              </div>
            </div>
          </aside>
        )}
        <div className="map-side">
          <div className="map-frame skeleton" />
        </div>
        <aside className="right-side">
          <div className="spot-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="spot-tile skeleton-tile" key={i}>
                <div className="tile-photo skeleton" />
                <div className="tile-meta">
                  <div className="skeleton sk-line title" />
                  <div className="skeleton sk-line sub" />
                </div>
              </div>
            ))}
          </div>
        </aside>
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
  // Category filter: empty = show all. Applies to both the grid and the map.
  const [activeCats, setActiveCats] = useState<SpotCategory[]>([]);
  // Planner agent: chat panel + the itinerary it maintains + map day filter.
  // The itinerary is derived from storage each render (localStorage is the
  // source of truth); the override covers the moment the agent saves, before
  // any store subscription fires (sample trips have none).
  const [itineraryOverride, setItineraryOverride] = useState<Itinerary | null>(null);
  const [activeDay, setActiveDay] = useState<PlanRender["activeDay"]>("all");
  // The map's category filter is a collapsed glass pill that fans open into
  // the full list of category chips; picking one applies it and collapses.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Right rail: "pins" (viewport grid / spot detail) or the day-by-day
  // itinerary timeline. Selecting any spot flips back to pins. The itinerary
  // tab (and the whole segmented control) only appears once a plan exists.
  const [rightTab, setRightTab] = useState<"pins" | "overview">("pins");
  // Which rail tab a spot detail was opened from, so closing it returns there
  // — e.g. picking a stop inside an itinerary day and closing lands back on
  // that day rather than dumping the user into the all-pins grid.
  const [spotOrigin, setSpotOrigin] = useState<"pins" | "overview">("pins");
  const [expandedDay, setExpandedDay] = useState<number | null>(null);
  // Spots the user starred as non-negotiable — the agent must include them.
  const [mustSeeIds, setMustSeeIds] = useState<string[]>(() => loadMustSees(tripId));
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

  // A plan exists once the agent has built at least one day. Before that the
  // right rail is pins-only (no segmented control); once it lands, the
  // itinerary becomes the primary tab. Switch during render (React's
  // adjust-state-on-change pattern) so the itinerary shows without a
  // one-frame flash of the pins tab.
  const hasItinerary = itinerary != null && itinerary.days.length > 0;
  const [prevHasItinerary, setPrevHasItinerary] = useState(false);
  if (hasItinerary !== prevHasItinerary) {
    setPrevHasItinerary(hasItinerary);
    if (hasItinerary) setRightTab("overview");
  }

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

  // Category filter feeds both the grid and the map pins. Memoized so its
  // array identity is stable across renders — TripMap effects depend on the
  // `spots` reference, and a fresh array every render would loop them
  // (pan → moveend → setBounds → re-render → new array → pan → …).
  const catFiltered = useMemo(() => {
    if (!trip) return [];
    if (activeCats.length === 0) return trip.spots;
    const activeSet = new Set(activeCats);
    return trip.spots.filter((s) => activeSet.has(s.category));
  }, [trip, activeCats]);

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

  // Where the selected spot sits in the plan (if anywhere) — powers the
  // "why it's in your plan" section on the spot card.
  const selectedPlanInfo = (() => {
    if (!selectedSpot || !itinerary) return null;
    for (let i = 0; i < itinerary.days.length; i++) {
      const stop = itinerary.days[i].stops.find(
        (s) => s.spotId === selectedSpot.id
      );
      if (stop) return { day: itinerary.days[i], dayIndex: i, stop };
    }
    return null;
  })();

  const toggleMustSee = (id: string) => {
    setMustSeeIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      saveMustSees(tripId, next);
      return next;
    });
  };

  // Selecting a spot from anywhere (map pin, grid tile, day brief, overview
  // stop) shows its detail — which lives on the pins tab.
  const selectSpot = (id: string | null) => {
    setSelectedId(id);
    if (id) {
      // Remember where we came from so the detail's close button returns there.
      setSpotOrigin(rightTab);
      setRightTab("pins");
    }
  };

  // Expanding a day card in the overview filters the map to that day (pins +
  // route line); the expanded card itself tells the day's story. Engaging a
  // day drops any category filter so the day's itinerary pins take over — the
  // filter and the plan overlay never fight for the map at once.
  const toggleOverviewDay = (i: number) => {
    setActiveCats([]);
    setExpandedDay((cur) => {
      const next = cur === i ? null : i;
      setActiveDay(next === null ? "all" : next);
      return next;
    });
  };

  return (
    // Clicking anywhere outside the pill clears the pinned highlight and closes
    // the videos dropdown
    <div
      className="trip-page"
      onClick={() => {
        setPinnedVideoId(null);
        setVideosOpen(false);
        setFiltersOpen(false);
      }}
    >
      <div className="trip-body">
        {/* Left rail: trip identity + the planner agent */}
        {!embed && (
          <aside className="left-side">
            <TripHead
              trip={trip}
              meta={[
                `${catFiltered.length} spots`,
                formatTripDates(trip),
                trip.query?.interests,
              ]
                .filter(Boolean)
                .join(" · ")}
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
            <PlannerChat
              trip={trip}
              isLocal={isLocal === true}
              itinerary={itinerary}
              mustSeeIds={mustSeeIds}
              onItineraryChange={setItineraryOverride}
            />
          </aside>
        )}

        <div className="map-side">
          <div className="map-frame">
            <TripMap
              destination={trip.destination}
              spots={catFiltered}
              selectedId={selectedId}
              highlightVideoId={highlightVideoId}
              fitVideoId={highlightVideoId}
              // Filters are master: while one is applied the map shows only the
              // filtered pins and the itinerary overlay (numbered day pins +
              // routes) is hidden so the two don't stack confusingly.
              plan={activeCats.length > 0 ? null : planRender}
              mustSeeIds={mustSeeIds}
              popupSpot={
                selectedSpot
                  ? {
                      id: selectedSpot.id,
                      lat: selectedSpot.lat,
                      lng: selectedSpot.lng,
                      name: selectedSpot.name,
                      sub: `${CATEGORY_EMOJI[selectedSpot.category]} ${
                        selectedSpot.category
                      } · ${selectedSpot.mentions.length} creator${
                        selectedSpot.mentions.length === 1 ? "" : "s"
                      }`,
                      photoUrl: spotCoverUrl(selectedSpot),
                    }
                  : null
              }
              onSelect={selectSpot}
              onBoundsChange={setBounds}
            />
            {/* Category filter lives over the map now — a glass pill that fans
                open into the full list of categories. Picking one applies it
                and collapses the tray. */}
            {catCounts.length > 1 && (
              <div
                className={`map-filters ${filtersOpen ? "open" : ""}`}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className={`mf-toggle ${activeCats.length > 0 ? "active" : ""} ${
                    filtersOpen ? "open" : ""
                  }`}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((o) => !o)}
                >
                  <svg
                    className="mf-funnel"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M1.5 3h13L9.5 8.5V13L6.5 14.5V8.5L1.5 3Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Filters</span>
                  {activeCats.length > 0 && (
                    <span className="mf-count">{activeCats.length}</span>
                  )}
                </button>
                <div className="mf-tray" inert={!filtersOpen}>
                  {catCounts.map(([cat, n], i) => {
                    const on = activeCats.includes(cat);
                    return (
                      <button
                        key={cat}
                        className={`mf-chip ${on ? "on" : ""}`}
                        style={{
                          transitionDelay: filtersOpen ? `${i * 22}ms` : "0ms",
                        }}
                        onClick={() =>
                          // Stay open so several categories can be picked; the
                          // tray only closes on a toggle re-click / outside click.
                          setActiveCats((prev) =>
                            prev.includes(cat)
                              ? prev.filter((c) => c !== cat)
                              : [...prev, cat]
                          )
                        }
                      >
                        <span className="mf-emoji">{CATEGORY_EMOJI[cat]}</span>
                        <span className="mf-label">{cat}</span>
                        <span className="mf-n">{n}</span>
                      </button>
                    );
                  })}
                  {activeCats.length > 0 && (
                    <button
                      className="mf-clear"
                      style={{
                        transitionDelay: filtersOpen
                          ? `${catCounts.length * 22}ms`
                          : "0ms",
                      }}
                      onClick={() => setActiveCats([])}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}
            {trip.status === "processing" && (
              <div className="map-progress">⚙️ {trip.progress}</div>
            )}
          </div>
        </div>

        {/* Right rail: the Itinerary timeline (once a plan exists — the
            primary tab) or Pins (viewport grid / spot detail). The segmented
            control only appears after the agent has built an itinerary; before
            that the rail is pins-only. */}
        <aside className="right-side" onClick={(e) => e.stopPropagation()}>
          {hasItinerary && (
            <div className="rail-tabs">
              <div
                className="rail-seg"
                role="tablist"
                aria-label="Right rail view"
                data-active={rightTab}
              >
                <span className="rail-seg-thumb" aria-hidden="true" />
                <button
                  role="tab"
                  aria-selected={rightTab === "overview"}
                  className={`rail-tab ${rightTab === "overview" ? "on" : ""}`}
                  onClick={() => setRightTab("overview")}
                >
                  Itinerary
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === "pins"}
                  className={`rail-tab ${rightTab === "pins" ? "on" : ""}`}
                  onClick={() => setRightTab("pins")}
                >
                  Pins
                </button>
              </div>
            </div>
          )}

          {hasItinerary && rightTab === "overview" ? (
            <TripOverview
              itinerary={itinerary}
              spotById={spotById}
              expandedDay={expandedDay}
              onToggleDay={toggleOverviewDay}
              onSelectSpot={selectSpot}
              onStartPlanning={() => {
                // The chat is always open in the left rail — just focus it.
                document
                  .querySelector<HTMLTextAreaElement>(
                    ".planner-inputrow textarea"
                  )
                  ?.focus();
              }}
            />
          ) : selectedSpot ? (
            <SpotCard
              key={selectedSpot.id} // remount per spot — photo carousel state must not leak between spots
              spot={selectedSpot}
              tripId={trip.id}
              local={isLocal === true}
              mustSee={mustSeeIds.includes(selectedSpot.id)}
              onToggleMustSee={() => toggleMustSee(selectedSpot.id)}
              planInfo={selectedPlanInfo}
              planColor={
                selectedPlanInfo ? dayColor(selectedPlanInfo.dayIndex) : undefined
              }
              onClose={() => {
                setSelectedId(null);
                setRightTab(spotOrigin);
              }}
            />
          ) : visibleSpots.length === 0 ? (
            <div className="empty-area">
              No spots in this part of the map — zoom out or pan around to see
              more.
            </div>
          ) : (
            <div className="spot-grid">
              {visibleSpots.map((spot) => (
                <button
                  key={spot.id}
                  className={`spot-tile ${
                    selectedId === spot.id ? "selected" : ""
                  }`}
                  onClick={() => selectSpot(spot.id)}
                >
                  <TilePhotos
                    spot={spot}
                    tripId={trip.id}
                    local={isLocal === true}
                  />
                  <div className="tile-meta">
                    <div className="tile-name">{spot.name}</div>
                    <div className="tile-sub">
                      {spot.mentions.length === 1
                        ? spot.mentions[0].channelName
                        : `${spot.mentions.length} creators recommend`}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The "Trip overview" tab: a numbered timeline of day cards built from the
 *  agent's itinerary. Clicking a card expands its stop-by-stop schedule and
 *  filters the map to that day. */
function TripOverview({
  itinerary,
  spotById,
  expandedDay,
  onToggleDay,
  onSelectSpot,
  onStartPlanning,
}: {
  itinerary: Itinerary | null;
  spotById: Map<string, Spot>;
  expandedDay: number | null;
  onToggleDay: (i: number) => void;
  onSelectSpot: (id: string) => void;
  onStartPlanning: () => void;
}) {
  if (!itinerary || itinerary.days.length === 0) {
    return (
      <div className="ov-empty">
        <div className="ov-empty-icon" aria-hidden="true">
          🗺️
        </div>
        <h3>No trip plan yet</h3>
        <p>
          Chat with your local planner to turn these spots into a day-by-day
          itinerary. Star the places you refuse to miss and the planner
          will build the days around them.
        </p>
        <button className="ov-empty-cta" onClick={onStartPlanning}>
          ✨ Start planning
        </button>
      </div>
    );
  }

  const plannedCount = itinerary.days.reduce((n, d) => n + d.stops.length, 0);

  return (
    <div className="overview">
      <div className="ov-head">
        <h3>Itinerary</h3>
        <span className="ov-places">
          🗺 {plannedCount} place{plannedCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="ov-timeline">
        {itinerary.days.map((day, i) => {
          const stops = day.stops.flatMap((st) => {
            const spot = spotById.get(st.spotId);
            return spot ? [{ ...st, spot }] : [];
          });
          const photoUrl =
            stops.map((s) => spotCoverUrl(s.spot)).find(Boolean) ?? null;
          const catCount = new Map<SpotCategory, number>();
          for (const s of stops) {
            catCount.set(s.spot.category, (catCount.get(s.spot.category) ?? 0) + 1);
          }
          const topCats = [...catCount.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([c]) => c);
          const open = expandedDay === i;

          return (
            <div className="ov-item" key={i}>
              <div className="ov-marker">
                <span className="ov-dot">{i + 1}</span>
                {i < itinerary.days.length - 1 && <span className="ov-line" />}
              </div>
              <div className={`ov-card ${open ? "open" : ""}`}>
                <button className="ov-card-main" onClick={() => onToggleDay(i)}>
                  {/* Full-bleed cover on top — edge to edge, no padding */}
                  {photoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="ov-cover" src={photoUrl} alt="" />
                  )}
                  <div className="ov-card-text">
                    <span className="ov-day-badge">
                      {day.label}
                      {day.date &&
                        ` · ${new Date(
                          day.date + "T00:00:00"
                        ).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}`}
                    </span>
                    <div className="ov-title">{day.theme ?? day.label}</div>
                    {topCats.length > 0 && (
                      <div className="ov-chips">
                        {topCats.map((c) => (
                          <span className="ov-chip" key={c}>
                            {CATEGORY_EMOJI[c]} {c}
                          </span>
                        ))}
                      </div>
                    )}
                    {day.rationale && (
                      <p className="ov-rationale ov-rationale-teaser">
                        {day.rationale}
                      </p>
                    )}
                  </div>
                </button>
                {/* Always mounted so open/close animates smoothly */}
                <div className={`ov-expand ${open ? "open" : ""}`} inert={!open}>
                  <div className="ov-expand-clip">
                    <div className="ov-stops">
                      <DaySchedule
                        day={day}
                        spotById={spotById}
                        onSelectSpot={onSelectSpot}
                        showDate={false}
                        showRationale={false}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** One day's schedule — the span line, the agent's rationale, and the stop
 *  rows. Shared verbatim between the map's day-brief overlay and the right
 *  rail's expanded day card, so the two can't drift apart visually. */
function DaySchedule({
  day,
  spotById,
  onSelectSpot,
  showDate = true,
  showRationale = true,
}: {
  day: ItineraryDay;
  spotById: Map<string, Spot>;
  onSelectSpot: (id: string) => void;
  showDate?: boolean;
  showRationale?: boolean;
}) {
  const stops = day.stops.flatMap((st) => {
    const spot = spotById.get(st.spotId);
    return spot ? [{ ...st, spot }] : [];
  });
  const first = stops.find((s) => s.time)?.time;
  const withEnd = [...stops].reverse().find((s) => s.time);
  const end =
    withEnd?.time && withEnd.durationMin
      ? addMinutes(withEnd.time, withEnd.durationMin)
      : withEnd?.time;
  const dateLabel =
    showDate && day.date
      ? new Date(day.date + "T00:00:00").toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : null;

  return (
    <>
      {(dateLabel || first) && (
        <div className="ov-span">
          {dateLabel && <span>{dateLabel}</span>}
          {dateLabel && first && <span className="ov-span-sep">·</span>}
          {first && <span>Start {first}</span>}
          {first && end && <span className="ov-span-sep">→</span>}
          {first && end && <span>done ~{end}</span>}
        </div>
      )}
      {!first && stops.length > 0 && (
        <div className="ov-untimed">
          No times on this plan yet — tell the planner &ldquo;add times to my
          days&rdquo; and it will fill in arrivals and durations.
        </div>
      )}
      {showRationale && day.rationale && (
        <p className="ov-rationale">{day.rationale}</p>
      )}
      {stops.map((st, k) => {
        const next = stops[k + 1];
        const gapMin = next
          ? travelEstimate(
              haversineKm(st.spot.lat, st.spot.lng, next.spot.lat, next.spot.lng)
            ).driveMin
          : null;
        return (
          <div className="ov-stop" key={st.spotId}>
            <button
              className="ov-stop-row"
              onClick={() => onSelectSpot(st.spotId)}
            >
              <span className="ov-stop-time">{st.time ?? "·"}</span>
              <span className="ov-stop-name">{st.spot.name}</span>
              {st.durationMin != null && (
                <span className="ov-stop-dur">
                  {formatDuration(st.durationMin)}
                </span>
              )}
            </button>
            {st.note && <div className="ov-stop-note">{st.note}</div>}
            {gapMin != null && (
              <div className="ov-stop-gap">~{gapMin} min travel</div>
            )}
          </div>
        );
      })}
    </>
  );
}

function addMinutes(hhmm: string, min: number): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return undefined;
  const total = (Number(m[1]) * 60 + Number(m[2]) + min) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60
  ).padStart(2, "0")}`;
}

function SpotCard({
  spot,
  tripId,
  local,
  mustSee,
  onToggleMustSee,
  planInfo,
  planColor,
  onClose,
}: {
  spot: Spot;
  tripId: string;
  local: boolean;
  mustSee: boolean;
  onToggleMustSee: () => void;
  planInfo?: { day: ItineraryDay; dayIndex: number; stop: ItineraryStop } | null;
  planColor?: string;
  onClose: () => void;
}) {
  const { urls, i, total, step } = useSpotPhotos(spot, tripId, local);
  // Google photo sets are all-Google; otherwise it's the single legacy photo
  // (wikimedia) or a frame from the recommending creator's video
  const credit =
    spot.photos && spot.photos.length > 0
      ? { Icon: IconCamera, label: "Google Maps" }
      : spot.photo
        ? spot.photo.source === "google"
          ? { Icon: IconCamera, label: "Google Maps" }
          : { Icon: IconCamera, label: "Wikimedia Commons" }
        : { Icon: IconVideo, label: spot.mentions[0]?.channelName ?? "" };

  return (
    <div className="spot-card">
      <button className="close" onClick={onClose} aria-label="Close">
        <IconClose />
      </button>
      {urls.length > 0 && (
        <div className="card-photo">
          {urls[i] ? (
            <CarouselImage key={urls[i]} src={urls[i]} alt={spot.name} />
          ) : (
            <div className="tile-photo-loading" />
          )}
          <span className="photo-credit">
            <credit.Icon />
            <span>{credit.label}</span>
          </span>
          <CarouselControls i={i} total={total} step={step} />
        </div>
      )}
      <div className="card-body">
        <div className="card-title-row">
          <h2>{spot.name}</h2>
          <button
            className={`must-star ${mustSee ? "on" : ""}`}
            onClick={onToggleMustSee}
            title={
              mustSee
                ? "Remove from must-sees"
                : "Star as a must-see — the planner will always include it"
            }
            aria-pressed={mustSee}
          >
            <IconStar />
            Must-see
          </button>
        </div>

        {/* One quiet meta line: the spot's key facts at a glance. When the
            spot isn't planned yet the line simply ends after the creator
            count — no dead "not planned" cell. */}
        <div className="spot-meta">
          {[
            spot.category,
            `${spot.mentions.length} creator${
              spot.mentions.length === 1 ? "" : "s"
            }`,
            ...(planInfo
              ? [planInfo.day.label, planInfo.stop.time ?? null]
              : []),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>

        <p className="desc">
          {spot.description}
          {spot.geocodeSource === "llm" && (
            <span className="approx-note"> (approximate location)</span>
          )}
        </p>

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

        {planInfo && (
          <div className="plan-why">
            <div className="plan-why-label">
              <span
                className="dot"
                style={planColor ? { background: planColor } : undefined}
              />
              In your plan — {planInfo.day.label}
              {planInfo.day.date &&
                ` (${new Date(
                  planInfo.day.date + "T00:00:00"
                ).toLocaleDateString(undefined, { weekday: "long" })})`}
              {planInfo.stop.time && ` · ${planInfo.stop.time}`}
              {planInfo.stop.durationMin != null &&
                ` · ${formatDuration(planInfo.stop.durationMin)}`}
            </div>
            {planInfo.stop.why && (
              <p className="plan-why-text">{planInfo.stop.why}</p>
            )}
            {planInfo.stop.note && (
              <p className="plan-why-note">
                <span className="tip-tag">Tip</span>
                {planInfo.stop.note}
              </p>
            )}
          </div>
        )}

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

        {/* Section label only — the rows below carry the names/avatars, so a
            single creator isn't repeated twice in a row. */}
        <div className="rec-label">
          Recommended by
          {spot.mentions.length === 1
            ? ""
            : ` ${spot.mentions.length} creators`}
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
            <div className="play">
              <IconPlay />
              {formatTimestamp(m.timestampSec)}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
