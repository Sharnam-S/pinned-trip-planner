"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
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
import { publishTrip, readOwnedIds } from "@/lib/clientStore";
import { loadTrip, peekTrip, saveTrip, subscribeTrips } from "@/lib/tripStore";
import { addVideosToTrip, ensureRunning, isRunning } from "@/lib/runner";
import { parseVideoId } from "@/lib/links";
import {
  extraPhotoCount,
  googlePhotoProxy,
  spotCoverUrl,
  spotPhotoUrl,
} from "@/lib/photoUrl";
import {
  dayColor,
  haversineKm,
  loadItinerary,
  loadMustSees,
  saveMustSees,
  travelEstimate,
} from "@/lib/itinerary";
import {
  applyFacets,
  formatDateRange,
  loadFacets,
  saveFacets,
  type TripFacets,
} from "@/lib/tripFacets";
import { tripFlag } from "@/lib/flags";
import { ICON_CARD, ICON_NAV } from "@/lib/ui";
import { useIsMobile } from "@/lib/useIsMobile";
import BuildingScreen from "./BuildingScreen";
import BottomSheet, { SheetSnap } from "./BottomSheet";
import PlannerChat from "./PlannerChat";
import TripHeader from "./TripHeader";
import type { MapBounds, PlanRender } from "./TripMap";

const TripMap = dynamic(() => import("./TripMap"), { ssr: false });

/** A place returned by the map geocoder (OSM), not one of our scraped spots. */
interface GeoPlace {
  id: string;
  name: string;
  label: string;
  lat: number;
  lng: number;
  /** [[south, west], [north, east]] when the place has an extent. */
  bounds: [[number, number], [number, number]] | null;
}

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
  return formatDateRange(trip.query?.startDate, trip.query?.endDate);
}

// How far a drag must travel horizontally before it pages the photo, and how
// far it must travel at all before we commit to calling it a swipe or a scroll.
const SWIPE_PX = 40;
const AXIS_LOCK_PX = 10;

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
      extraPhotoCount(spot) > 0);
  const googleCount =
    (spot.photos?.length ?? (spot.photo ? 1 : 0)) + extraPhotoCount(spot);

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
          const trip = peekTrip(tripId);
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
            void saveTrip(trip);
          }
        }
      })
      .catch(() => {
        fetchingRef.current = false; // allow retry on the next swipe
      });
  };

  const go = (delta: number) => {
    ensureAll();
    setIndex(Math.min(total - 1, Math.max(0, i + delta)));
  };

  const step = (e: React.MouseEvent, delta: number) => {
    e.stopPropagation(); // don't select the spot behind the arrow
    go(delta);
  };

  // Drag across the photo to page through it — on touch that's the only way
  // to get past the cover, since the hover arrows never appear. Move/up go on
  // window: mouse pointers get no implicit capture, so element-scoped handlers
  // would drop the gesture the moment it left the photo. The element's
  // `touch-action: pan-y` leaves vertical scrolling to the browser.
  const swipedRef = useRef(false);
  const swipe = {
    onPointerDown: (e: React.PointerEvent) => {
      if (total <= 1) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let axis: "x" | "y" | null = null;
      swipedRef.current = false;

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        // The first real movement decides swipe vs scroll; once it's a scroll
        // we bow out for the rest of the gesture.
        if (!axis) {
          if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
          axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
          if (axis === "y") return end();
        }
        if (Math.abs(dx) < SWIPE_PX) return;
        swipedRef.current = true;
        go(dx < 0 ? 1 : -1); // one photo per swipe
        end();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    // A swipe on a grid tile shouldn't also select the spot behind it.
    onClickCapture: (e: React.MouseEvent) => {
      if (!swipedRef.current) return;
      swipedRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return { urls, i, total, step, swipe };
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
        draggable={false} // a mouse swipe shouldn't start a native image drag
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
// same language as the carousel chevrons). Colored by currentColor. Sized by
// the design system's two icon steps (ICON_NAV / ICON_CARD). ---

function IconCamera() {
  return (
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M9 7l1.6-2.6h2.8L15 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function IconVideo() {
  return (
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M10.5 9.3l4.6 2.7-4.6 2.7z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width={ICON_CARD} height={ICON_CARD} viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 1.3l6 3.7-6 3.7z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Airbnb-style tile photo carousel: arrows appear on hover, dots track the
// current photo. Single-photo spots render a plain image.
function TilePhotos({ spot, tripId, local }: { spot: Spot; tripId: string; local: boolean }) {
  const { urls, i, total, step, swipe } = useSpotPhotos(spot, tripId, local);

  return (
    <div className="tile-photo" {...swipe}>
      {urls[i] ? (
        <CarouselImage key={urls[i]} src={urls[i]} alt={spot.name} />
      ) : urls.length > 0 ? (
        <div className="tile-photo-loading" /> // swiped ahead of the lazy fetch
      ) : (
        <div className="tile-photo-fallback">{CATEGORY_EMOJI[spot.category]}</div>
      )}
      <CarouselControls i={i} total={total} step={step} />
    </div>
  );
}

// The source-videos control at the top of the left rail, with the video list
// (and add-videos box) expanding below it. On phones it also carries the trip's
// identity line, because the phone layout has no trip header to put it in —
// `identity` is what tells the two apart.
function TripHead({
  trip,
  meta,
  identity,
  flag,
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
  identity: boolean;
  flag: string | null;
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
        {identity && (
          <div className="th-id">
            <h1 className="th-name">
              {flag && (
                <span className="trip-flag" aria-hidden="true">
                  {flag}
                </span>
              )}
              <span className="trip-name-text">{trip.name}</span>
            </h1>
            <div className="th-meta">{meta}</div>
          </div>
        )}
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
              <div className="videos-note">
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

/**
 * Share, top-right of the right rail. First share publishes the trip to the
 * public community gallery (owner id stripped — the public copy is anonymous)
 * and opens a popover with a copyable link. Once public, the button just
 * copies the link (and silently refreshes the public copy so friends see the
 * latest version).
 */
function ShareTrip({ trip }: { trip: Trip }) {
  const [shared, setShared] = useState(() => readOwnedIds().includes(trip.id));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [copied, setCopied] = useState(false); // button flash (already-shared path)
  const [popupCopied, setPopupCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/trip/${trip.id}`
      : `/trip/${trip.id}`;

  useEffect(() => {
    if (!popupOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPopupOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPopupOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [popupOpen]);

  async function copyLink(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false; // e.g. no clipboard permission — the popup input is the fallback
    }
  }

  async function onShareClick() {
    if (busy) return;
    setFailed(false);
    if (shared) {
      // Already public: hand over the link; refresh the public copy quietly.
      void publishTrip({ ...trip, ownerId: undefined });
      if (await copyLink()) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        setPopupOpen(true);
      }
      return;
    }
    setBusy(true);
    const ok = await publishTrip({ ...trip, ownerId: undefined });
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    setShared(true);
    setPopupCopied(false);
    setPopupOpen(true);
  }

  return (
    <div className="share-trip" ref={rootRef}>
      <button
        className={`share-btn${shared ? " shared" : ""}`}
        onClick={onShareClick}
        disabled={busy}
        title={
          shared
            ? "Public — click to copy the link"
            : "Make this trip public and get a shareable link"
        }
      >
        <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M9.5 4.5L7 2m0 0L4.5 4.5M7 2v7"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2.5 7.5v3A1.5 1.5 0 004 12h6a1.5 1.5 0 001.5-1.5v-3"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
        {busy ? "Sharing…" : failed ? "Retry share" : copied ? "Link copied ✓" : "Share"}
      </button>

      {popupOpen && (
        <div className="share-pop" role="dialog" aria-label="Share this trip">
          <div className="share-pop-title">This trip is now public</div>
          <p className="share-pop-sub">
            Anyone with the link can view the map and plan — it&rsquo;s also in
            the community gallery on the homepage.
          </p>
          <div className="share-pop-row">
            <input
              type="text"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              className="share-pop-copy"
              onClick={async () => {
                if (await copyLink()) {
                  setPopupCopied(true);
                  setTimeout(() => setPopupCopied(false), 2000);
                }
              }}
            >
              {popupCopied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Airbnb-style loading skeleton: a shimmering ghost of the real trip page so
// the left rail, map, and right grid slot in place before the data lands.
function TripSkeleton({ embed = false }: { embed?: boolean }) {
  return (
    <div className="trip-page">
      {!embed && (
        <header className="trip-header">
          <div className="skeleton sk-line title" style={{ width: 180 }} />
          <div className="trip-facets">
            {[104, 116, 108].map((w) => (
              <div className="skeleton sk-facet" key={w} style={{ width: w }} />
            ))}
          </div>
          <div className="trip-header-actions" />
        </header>
      )}
      <div className="trip-body">
        {!embed && (
          <aside className="left-side">
            <div className="trip-head">
              <div className="th-row">
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
  // Map search: type a place and the map flies to it (Google-Maps style). The
  // category filter now lives in the right rail alongside the pins.
  const [searchQuery, setSearchQuery] = useState("");
  // Whether the search results dropdown is showing (focused with a query).
  const [searchOpen, setSearchOpen] = useState(false);
  // Geocoded "real map" places for the current query (OSM Nominatim, via our
  // proxy), and whether that request is in flight.
  const [geoResults, setGeoResults] = useState<GeoPlace[]>([]);
  const [geoLoading, setGeoLoading] = useState(false);
  // A transient marker for a searched place that isn't one of our pins.
  const [searchMarker, setSearchMarker] = useState<{
    lat: number;
    lng: number;
    label: string;
  } | null>(null);
  // The pins-rail category filters collapse to a single button by default and
  // fan open on click — the full chip grid was too heavy to sit open always.
  const [pinFiltersOpen, setPinFiltersOpen] = useState(false);
  // A one-shot fly-to command for the map. Bumping `key` re-triggers the fly
  // even to the same coords (search the same place twice → it re-centers).
  const [flyTo, setFlyTo] = useState<{
    lat: number;
    lng: number;
    zoom?: number;
    /** When set, the map fits this box instead of centering on lat/lng. */
    bounds?: [[number, number], [number, number]] | null;
    key: number;
  } | null>(null);
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
  // The header's three answers (dates / interests / who's going). They come off
  // the loaded trip, so they can't be read until it lands.
  const [facets, setFacets] = useState<TripFacets>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mobile layout: the map is the page background and everything else lives
  // in a snap-point bottom sheet with its own tab strip (Agent / Itinerary /
  // Pins). Both states are harmless to keep updated on desktop, so handlers
  // shared between the layouts just set them unconditionally.
  const isMobile = useIsMobile();
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>("half");
  const [sheetTab, setSheetTab] = useState<"agent" | "overview" | "pins">(
    embed ? "pins" : "agent"
  );

  // Draggable divider between the planner rail and the map. `leftWidth` is a
  // pixel override; null means "use the responsive CSS width" (the default and
  // what a double-click restores). The map is flex:1 so it absorbs whatever the
  // rail gives up. Min widths keep both panels usable.
  const bodyRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const [leftWidth, setLeftWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  const clampLeft = useCallback((raw: number) => {
    const body = bodyRef.current;
    if (!body) return raw;
    const LEFT_MIN = 300;
    const MAP_MIN = 420;
    const PAD = 14; // .trip-body padding
    const GAP = 14; // rail↔map and map↔detail gaps (the resizer straddles one)
    const rightW = rightRef.current?.offsetWidth ?? 0;
    const maxLeft = body.clientWidth - PAD * 2 - GAP * 2 - rightW - MAP_MIN;
    return Math.max(LEFT_MIN, Math.min(raw, Math.max(LEFT_MIN, maxLeft)));
  }, []);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const body = bodyRef.current;
      if (!body) return;
      setResizing(true);
      const move = (ev: PointerEvent) => {
        const rect = body.getBoundingClientRect();
        setLeftWidth(clampLeft(ev.clientX - rect.left - 14));
      };
      const up = () => {
        setResizing(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [clampLeft]
  );

  // Keep a user-set rail width valid when the window resizes — otherwise a
  // shrinking viewport could crush the map below its minimum.
  useEffect(() => {
    if (leftWidth == null) return;
    const onResize = () => setLeftWidth((w) => (w == null ? w : clampLeft(w)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [leftWidth, clampLeft]);

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
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      // Mine? The store knows where to look — the account when signed in, this
      // browser when not. Either way it comes back as the editable copy.
      const mine = await loadTrip(tripId);
      if (cancelled) return;
      if (mine) {
        setIsLocal(true);
        setTrip(mine);
        // resume an interrupted build (page refresh mid-processing)
        if (mine.status === "processing" && !isRunning(tripId)) {
          ensureRunning(tripId);
        }
        unsubscribe = subscribeTrips(() => {
          const t = peekTrip(tripId);
          if (t) setTrip(t);
        });
        return;
      }
      setIsLocal(false);
      // Not mine: a sample or someone's published copy — read-only, and a
      // visitor's plan for it lives in localStorage overlays.
      const res = await fetch(`/api/trips/${tripId}`).catch(() => null);
      if (cancelled) return;
      if (!res || res.status === 404) {
        setNotFound(true);
        return;
      }
      const data: Trip = await res.json();
      if (cancelled) return;
      setTrip(data);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [tripId]);

  // Read the header's answers when the trip lands, and re-read them if the
  // stored query changes underneath us (account sync, another tab). Adjusted
  // during render rather than in an effect — same pattern as `rightTab` below,
  // and it avoids a frame of empty pills. Edits go through `updateFacets`.
  const facetSource = trip ? `${trip.id}:${JSON.stringify(trip.query ?? null)}` : null;
  const [facetsFrom, setFacetsFrom] = useState<string | null>(null);
  if (trip && facetSource !== facetsFrom) {
    setFacetsFrom(facetSource);
    setFacets(loadFacets(trip));
  }

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

  // Sharing sits in the trip header (desktop) / the pins panel (phone): your
  // own finished trip, not the embedded landing preview, and only once there's
  // something to show.
  const canShare =
    !embed &&
    isLocal === true &&
    trip != null &&
    trip.status === "ready" &&
    trip.spots.length > 0;
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

  // A Nominatim viewbox around this trip's spots so geocoder results are
  // biased to the destination (searching "beach" in a Sri Lanka trip shouldn't
  // surface a beach in Australia first). Format: left,top,right,bottom.
  const geoViewbox = useMemo(() => {
    if (!trip || trip.spots.length === 0) return null;
    let minLat = 90,
      maxLat = -90,
      minLng = 180,
      maxLng = -180;
    for (const s of trip.spots) {
      minLat = Math.min(minLat, s.lat);
      maxLat = Math.max(maxLat, s.lat);
      minLng = Math.min(minLng, s.lng);
      maxLng = Math.max(maxLng, s.lng);
    }
    return `${minLng},${maxLat},${maxLng},${minLat}`;
  }, [trip]);

  // Query the real map (OSM geocoder, via our proxy) as the user types —
  // debounced, and only for queries long enough to be meaningful. Results are
  // merged with our own pinned spots in the dropdown so search covers both the
  // actual map and the YouTube-scraped points.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 3) {
      setGeoResults([]);
      setGeoLoading(false);
      return;
    }
    setGeoLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const url = `/api/geocode?q=${encodeURIComponent(q)}${
          geoViewbox ? `&viewbox=${encodeURIComponent(geoViewbox)}` : ""
        }`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`geocode ${res.status}`);
        const data: GeoPlace[] = await res.json();
        setGeoResults(data);
      } catch {
        // Aborted (new keystroke) or network error — just drop map results;
        // the local spot matches still show.
        if (!ctrl.signal.aborted) setGeoResults([]);
      } finally {
        if (!ctrl.signal.aborted) setGeoLoading(false);
      }
    }, 350);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [searchQuery, geoViewbox]);

  // Every spot that sits somewhere in the itinerary. Feeds the map's subtle
  // "covered" pin treatment — kept separate from the plan overlay so it stays
  // visible while a category filter is applied (the overlay is hidden then).
  const coveredIds = useMemo(
    () =>
      itinerary
        ? itinerary.days.flatMap((d) => d.stops.map((s) => s.spotId))
        : [],
    [itinerary]
  );

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

  // Our own scraped spots that match the query, across ALL spots (not just the
  // filtered/in-view set). Name matches first, then category matches. These are
  // the "pinned" results — the ones from our YouTube research.
  const spotResults = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return trip.spots
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const an = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bn = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return an - bn || b.mentions.length - a.mentions.length;
      })
      .slice(0, 5);
  })();
  const hasResults = spotResults.length > 0 || geoResults.length > 0;
  // While typing, the matching pinned spots pulse on the map so you can see
  // which of the searched places are ones we scraped from YouTube.
  const searchMatchIds =
    searchOpen && searchQuery.trim() ? spotResults.map((s) => s.id) : [];

  // Picking a pinned spot flies the map to it and opens its detail. If a
  // category filter would hide it, clear the filter so the pin is there when we
  // arrive — search overrides filtering, like Google Maps.
  const goToSearchResult = (spot: Spot) => {
    if (activeCats.length > 0 && !activeCats.includes(spot.category)) {
      setActiveCats([]);
    }
    setSearchMarker(null);
    setFlyTo((prev) => ({
      lat: spot.lat,
      lng: spot.lng,
      zoom: 14,
      bounds: null,
      key: (prev?.key ?? 0) + 1,
    }));
    selectSpot(spot.id);
    setSearchQuery(spot.name);
    setSearchOpen(false);
  };

  // Picking a plain map place (not one of our spots): fly there, drop a
  // transient marker so you can see where it landed, and leave our pins in
  // place so any that sit inside the area come into view alongside it.
  const goToPlace = (place: GeoPlace) => {
    setSelectedId(null);
    setSearchMarker({ lat: place.lat, lng: place.lng, label: place.name });
    setFlyTo((prev) => ({
      lat: place.lat,
      lng: place.lng,
      zoom: 14,
      bounds: place.bounds,
      key: (prev?.key ?? 0) + 1,
    }));
    setSearchQuery(place.name);
    setSearchOpen(false);
  };

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
              return spot
                ? [
                    {
                      spot,
                      note: st.note,
                      slot: st.slot,
                      time: st.time,
                      durationMin: st.durationMin,
                    },
                  ]
                : [];
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

  // Header edits write through immediately: onto the trip for a trip you own,
  // into a per-browser overlay for a sample trip.
  const updateFacets = (patch: Partial<TripFacets>) => {
    const next = { ...facets, ...patch };
    setFacets(next);
    saveFacets(tripId, isLocal === true, next);
  };

  // Selecting a spot from anywhere (map pin, grid tile, day brief, overview
  // stop) shows its detail — which lives on the pins tab.
  const selectSpot = (id: string | null) => {
    setSelectedId(id);
    if (id) {
      // Remember where we came from so the detail's close button returns there.
      setSpotOrigin(
        isMobile ? (sheetTab === "overview" ? "overview" : "pins") : rightTab
      );
      setRightTab("pins");
      setSheetTab("pins");
      // A pin tapped while the sheet is collapsed should actually show the
      // card it just opened. Functional update: map pin handlers can hold a
      // stale closure of this component's render.
      setSheetSnap((s) => (s === "peek" ? "half" : s));
    }
  };

  const closeSpot = () => {
    setSelectedId(null);
    setRightTab(spotOrigin);
    setSheetTab(spotOrigin);
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

  // Clicking anywhere outside the panels clears the pinned video highlight
  // and closes the videos dropdown / search results.
  const clearTransients = () => {
    setPinnedVideoId(null);
    setVideosOpen(false);
    setSearchOpen(false);
  };

  // ---- Building blocks shared by the desktop rails and the mobile sheet ----

  // What the planner sees: the stored trip with the header's answers folded in,
  // so editing dates or who's going reaches the agent on the next message.
  // Not memoized — every hook in this component sits above the early returns
  // above, and the merge is two object spreads.
  const plannerTrip = applyFacets(trip, facets);

  const tripHeadEl = !embed ? (
    <TripHead
      trip={trip}
      // Desktop puts identity in the trip header instead (see below).
      identity={isMobile}
      flag={tripFlag(trip)}
      meta={[
        `${catFiltered.length} spots`,
        formatTripDates(plannerTrip),
        plannerTrip.query?.interests,
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
  ) : null;

  const chatEl = !embed ? (
    <PlannerChat
      trip={plannerTrip}
      isLocal={isLocal === true}
      itinerary={itinerary}
      mustSeeIds={mustSeeIds}
      onItineraryChange={setItineraryOverride}
      onSelectSpot={selectSpot}
    />
  ) : null;

  const mapFrameEl = (
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
              coveredIds={coveredIds}
              // On mobile the bottom sheet already shows the selected spot's
              // card, so the map popup would just duplicate it (and cover the
              // pin). Desktop keeps it.
              popupSpot={
                selectedSpot && !isMobile
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
              flyTo={flyTo}
              searchMatchIds={searchMatchIds}
              searchMarker={searchMarker}
            />
            {/* Mobile only (hidden by CSS on desktop): the way back to the
                trips list — the phone layout has no other exit. */}
            {!embed && (
              <Link className="m-back" href="/" aria-label="Back to your trips">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M19 12H5m0 0l7-7m-7 7l7 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            )}
            {/* Search over the actual map: our pinned spots + real OSM places.
                Type a place and the map flies to it, like Google Maps. */}
            <div
              className={`map-search ${searchOpen && hasResults ? "open" : ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ms-box">
                <svg
                  className="ms-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.6" />
                  <path
                    d="M11 11l3.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  className="ms-input"
                  type="text"
                  placeholder="Search places on the map…"
                  value={searchQuery}
                  aria-label="Search places on the map"
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (spotResults.length > 0) goToSearchResult(spotResults[0]);
                      else if (geoResults.length > 0) goToPlace(geoResults[0]);
                    } else if (e.key === "Escape") {
                      setSearchOpen(false);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                {searchQuery && (
                  <button
                    className="ms-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchQuery("");
                      setSearchOpen(false);
                      setSearchMarker(null);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {searchOpen && searchQuery.trim() && (
                <div className="ms-results">
                  {/* Our YouTube-scraped pins first — the "highlighted" ones. */}
                  {spotResults.length > 0 && (
                    <>
                      <div className="ms-group">Pinned in this trip</div>
                      {spotResults.map((spot) => (
                        <button
                          key={spot.id}
                          className="ms-result pinned"
                          onClick={() => goToSearchResult(spot)}
                        >
                          <span className="ms-result-emoji">
                            {CATEGORY_EMOJI[spot.category]}
                          </span>
                          <span className="ms-result-text">
                            <span className="ms-result-name">{spot.name}</span>
                            <span className="ms-result-sub">
                              {spot.category}
                              {spot.mentions.length > 0
                                ? ` · ${spot.mentions.length} creator${
                                    spot.mentions.length === 1 ? "" : "s"
                                  }`
                                : ""}
                            </span>
                          </span>
                          <span className="ms-pin-tag" aria-label="Pinned spot">
                            📍
                          </span>
                        </button>
                      ))}
                    </>
                  )}

                  {/* Anywhere else on the real map, via the OSM geocoder. */}
                  {geoResults.length > 0 && (
                    <>
                      <div className="ms-group">Places on the map</div>
                      {geoResults.map((place) => (
                        <button
                          key={place.id}
                          className="ms-result"
                          onClick={() => goToPlace(place)}
                        >
                          <span className="ms-result-emoji ms-geo-icon" aria-hidden="true">
                            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                              <path
                                d="M8 1.5c-2.5 0-4.5 2-4.5 4.5 0 3.2 4.5 8 4.5 8s4.5-4.8 4.5-8c0-2.5-2-4.5-4.5-4.5Z"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinejoin="round"
                              />
                              <circle cx="8" cy="6" r="1.6" fill="currentColor" />
                            </svg>
                          </span>
                          <span className="ms-result-text">
                            <span className="ms-result-name">{place.name}</span>
                            <span className="ms-result-sub">{place.label}</span>
                          </span>
                        </button>
                      ))}
                    </>
                  )}

                  {!hasResults &&
                    (geoLoading ? (
                      <div className="ms-empty">Searching the map…</div>
                    ) : (
                      <div className="ms-empty">No places match “{searchQuery}”</div>
                    ))}
                </div>
              )}
            </div>
            {trip.status === "processing" && (
              <div className="map-progress">⚙️ {trip.progress}</div>
            )}
          </div>
  );

  const overviewEl = hasItinerary ? (
    <TripOverview
      itinerary={itinerary}
      spotById={spotById}
      expandedDay={expandedDay}
      onToggleDay={toggleOverviewDay}
      onSelectSpot={selectSpot}
      onStartPlanning={() => {
        // Chat lives in the left rail (desktop) or the Agent tab (mobile).
        setSheetTab("agent");
        document
          .querySelector<HTMLTextAreaElement>(".planner-inputrow textarea")
          ?.focus();
      }}
    />
  ) : null;

  const spotCardEl = selectedSpot ? (
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
      onClose={closeSpot}
    />
  ) : null;

  const pinsViewEl = (
            <div className="pins-view">
              {/* Category filters — collapsed to a single button by default,
                  fanning open into the full multi-select chip grid on click.
                  Empty selection = show everything. */}
              {catCounts.length > 1 && (
                <div className={`pins-filters ${pinFiltersOpen ? "open" : ""}`}>
                  <button
                    className={`pf-toggle ${activeCats.length > 0 ? "active" : ""}`}
                    aria-expanded={pinFiltersOpen}
                    onClick={() => setPinFiltersOpen((o) => !o)}
                  >
                    <svg
                      className="pf-funnel"
                      width={ICON_NAV}
                      height={ICON_NAV}
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
                      <span className="pf-count">{activeCats.length}</span>
                    )}
                    <svg
                      className="pf-chevron"
                      width={ICON_NAV}
                      height={ICON_NAV}
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 4.5L6 8l3.5-3.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <div className="pf-tray" inert={!pinFiltersOpen}>
                    {catCounts.map(([cat, n]) => {
                      const on = activeCats.includes(cat);
                      return (
                        <button
                          key={cat}
                          className={`pf-chip ${on ? "on" : ""}`}
                          aria-pressed={on}
                          onClick={() =>
                            setActiveCats((prev) =>
                              prev.includes(cat)
                                ? prev.filter((c) => c !== cat)
                                : [...prev, cat]
                            )
                          }
                        >
                          <span className="pf-emoji">{CATEGORY_EMOJI[cat]}</span>
                          <span className="pf-label">{cat}</span>
                          <span className="pf-n">{n}</span>
                        </button>
                      );
                    })}
                    {activeCats.length > 0 && (
                      <button className="pf-clear" onClick={() => setActiveCats([])}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
              {visibleSpots.length === 0 ? (
                <div className="empty-area">
                  No spots in this part of the map — zoom out or pan around to
                  see more.
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
                      {/* Mobile only (hidden on desktop by CSS). A span, not
                          a <button> — it lives inside the tile button. */}
                      <span
                        className={`tile-star ${
                          mustSeeIds.includes(spot.id) ? "on" : ""
                        }`}
                        role="button"
                        aria-label={
                          mustSeeIds.includes(spot.id)
                            ? "Remove from must-sees"
                            : "Star as a must-see"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMustSee(spot.id);
                        }}
                      >
                        <IconStar />
                      </span>
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
            </div>
  );

  // ---- Mobile: fullscreen map + bottom sheet (Agent / Itinerary / Pins) ----
  if (isMobile) {
    // The stored tab can point at a panel that doesn't exist right now (the
    // itinerary was cleared, or this is the embedded preview with no agent).
    const activeTab =
      (sheetTab === "overview" && !hasItinerary) ||
      (sheetTab === "agent" && embed)
        ? "pins"
        : sheetTab;
    return (
      <div className="trip-page mobile" onClick={clearTransients}>
        <div className="m-map">{mapFrameEl}</div>
        <BottomSheet
          snap={sheetSnap}
          onSnapChange={setSheetSnap}
          header={
            <div className="sheet-tabs" role="tablist" aria-label="Trip panels">
              {!embed && (
                <button
                  role="tab"
                  aria-selected={activeTab === "agent"}
                  className={`sheet-tab ${activeTab === "agent" ? "on" : ""}`}
                  onClick={() => setSheetTab("agent")}
                >
                  Agent
                </button>
              )}
              {hasItinerary && (
                <button
                  role="tab"
                  aria-selected={activeTab === "overview"}
                  className={`sheet-tab ${activeTab === "overview" ? "on" : ""}`}
                  onClick={() => setSheetTab("overview")}
                >
                  Itinerary
                </button>
              )}
              <button
                role="tab"
                aria-selected={activeTab === "pins"}
                className={`sheet-tab ${activeTab === "pins" ? "on" : ""}`}
                onClick={() => setSheetTab("pins")}
              >
                Pins
              </button>
            </div>
          }
        >
          {/* Panels stay mounted while hidden so the chat (in-flight stream,
              scroll position) survives tab switches. */}
          {!embed && (
            <div className="sheet-panel agent" hidden={activeTab !== "agent"}>
              {tripHeadEl}
              {chatEl}
            </div>
          )}
          {hasItinerary && (
            <div
              className="sheet-panel scroll"
              hidden={activeTab !== "overview"}
            >
              {overviewEl}
            </div>
          )}
          <div className="sheet-panel scroll" hidden={activeTab !== "pins"}>
            {canShare && !selectedSpot && (
              <div className="sheet-share">
                <ShareTrip trip={trip} />
              </div>
            )}
            {spotCardEl ?? pinsViewEl}
          </div>
        </BottomSheet>
      </div>
    );
  }

  // ---- Desktop: header over [chat] | map (center) | [itinerary/pins] ----
  return (
    <div
      className={`trip-page ${resizing ? "resizing" : ""}`}
      onClick={clearTransients}
    >
      {/* One header for the whole trip: the place, the three answers the
          planner needs, and sharing. The landing preview (embed) drops it. */}
      {!embed && (
        <TripHeader
          name={trip.name}
          flag={tripFlag(trip)}
          facets={facets}
          onChange={updateFacets}
          action={canShare ? <ShareTrip trip={trip} /> : null}
        />
      )}
      <div className="trip-body" ref={bodyRef}>
        {/* Left rail: source videos + the planner agent */}
        {!embed && (
          <aside
            className="left-side"
            style={leftWidth != null ? { width: leftWidth, minWidth: 0 } : undefined}
          >
            {tripHeadEl}
            {chatEl}
          </aside>
        )}

        {/* Drag to rebalance the planner rail and the map; double-click resets. */}
        {!embed && (
          <div
            className={`rail-resizer ${resizing ? "resizing" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize planner panel"
            onPointerDown={startResize}
            onDoubleClick={() => setLeftWidth(null)}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="rail-resizer-grip" />
          </div>
        )}

        <div className="map-side">{mapFrameEl}</div>

        {/* Right rail: the Itinerary timeline (once a plan exists — the
            primary tab) or Pins (viewport grid / spot detail). The segmented
            control only appears after the agent has built an itinerary; before
            that the rail is pins-only. */}
        <aside className="right-side" ref={rightRef} onClick={(e) => e.stopPropagation()}>
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

          {hasItinerary && rightTab === "overview"
            ? overviewEl
            : spotCardEl ?? pinsViewEl}
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
                    {day.rationale && (
                      <p className="ov-rationale ov-rationale-teaser">
                        {day.rationale}
                      </p>
                    )}
                    {topCats.length > 0 && (
                      <div className="ov-chips">
                        {topCats.map((c) => (
                          <span className="ov-chip" key={c}>
                            {CATEGORY_EMOJI[c]} {c}
                          </span>
                        ))}
                      </div>
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
  const { urls, i, total, step, swipe } = useSpotPhotos(spot, tripId, local);
  // Official Maps URL scheme — free, no API call. With a placeId it opens the
  // actual place page (reviews, hours, directions); without one it falls back
  // to a coordinate search. Rendered twice: a text pill in the body (desktop)
  // and an icon-only square in the title row (mobile) — CSS shows one each.
  const mapsHref =
    typeof spot.placeId === "string"
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          spot.name
        )}&query_place_id=${spot.placeId}`
      : `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`;
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
        <div className="card-photo" {...swipe}>
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
          <div className="title-actions">
            <a
              className="gmaps-icon"
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Google Maps"
              title="Open in Google Maps"
            >
              <svg width={ICON_CARD} height={ICON_CARD} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="2" />
              </svg>
            </a>
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
              <span className="must-star-label">Must-see</span>
            </button>
          </div>
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
          href={mapsHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
