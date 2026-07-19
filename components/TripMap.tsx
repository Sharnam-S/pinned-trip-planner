"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Destination, ItineraryStay, Spot } from "@/lib/types";
import { CATEGORY_EMOJI } from "@/lib/categories";

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** One itinerary day resolved to real spots, ready to draw. */
export interface PlanDayRender {
  label: string;
  color: string;
  stops: { spot: Spot; note?: string }[];
}

/** The whiteboard state: which days exist, which are visible. */
export interface PlanRender {
  days: PlanDayRender[];
  stay?: ItineraryStay | null;
  /** 'all' shows every day; a number shows that day; 'unassigned' shows only unplanned pills. */
  activeDay: "all" | number | "unassigned";
}

interface Props {
  destination: Destination;
  spots: Spot[];
  selectedId: string | null;
  /** When set, pins mentioned in this video light up and the rest dim. */
  highlightVideoId?: string | null;
  /** When set (video pinned), the map fits to that video's spots. */
  fitVideoId?: string | null;
  /** Planner itinerary overlay — numbered day pins + route lines. */
  plan?: PlanRender | null;
  /** Spot ids the user starred as must-sees — pills get a star badge. */
  mustSeeIds?: string[];
  /** Small photo card anchored to the selected spot (the full detail card
   *  lives in the page's right rail now). */
  popupSpot?: {
    id: string;
    lat: number;
    lng: number;
    name: string;
    sub: string;
    photoUrl: string | null;
  } | null;
  /** null = clicked the map background (deselect). */
  onSelect: (id: string | null) => void;
  onBoundsChange?: (bounds: MapBounds) => void;
}

export default function TripMap({
  destination,
  spots,
  selectedId,
  highlightVideoId = null,
  fitVideoId = null,
  plan = null,
  mustSeeIds = [],
  popupSpot = null,
  onSelect,
  onBoundsChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const planLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [destination.lat, destination.lng],
      zoom: destination.zoom,
      zoomControl: false,
      attributionControl: true,
    });
    // No zoom buttons — pinch/scroll/double-tap gestures cover it.
    // CARTO Positron: near-grayscale tiles so the ink pins, day colors, and
    // photos carry all the color (mood-board look).
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);
    mapRef.current = map;
    planLayerRef.current = L.layerGroup().addTo(map);

    // Tell the parent what's in frame so it can filter the spot list.
    const emitBounds = () => {
      const b = map.getBounds();
      onBoundsChangeRef.current?.({
        north: b.getNorth(),
        south: b.getSouth(),
        east: b.getEast(),
        west: b.getWest(),
      });
    };
    map.on("moveend zoomend", emitBounds);
    emitBounds();

    // Clicking the map background clears the selection (marker clicks don't
    // bubble here). onSelect is a stable setState — safe in this closure.
    map.on("click", () => onSelect(null));

    // The map mounts inside a flex container that may not have its final size
    // yet (dynamic import); without this Leaflet renders a zoomed-out sliver.
    let alive = true;
    const ro = new ResizeObserver(() => {
      if (alive) map.invalidateSize();
    });
    ro.observe(containerRef.current);
    requestAnimationFrame(() => {
      if (alive) map.invalidateSize();
    });

    return () => {
      alive = false;
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      planLayerRef.current = null;
      markersRef.current.clear();
      fittedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which planned spots are currently drawn as numbered day pins (they replace
  // the regular pill), and which pills should dim behind the active plan view.
  const planVisibleIds = new Set<string>();
  const planAllIds = new Set<string>();
  if (plan) {
    plan.days.forEach((day, i) => {
      for (const stop of day.stops) {
        planAllIds.add(stop.spot.id);
        if (plan.activeDay === "all" || plan.activeDay === i) {
          planVisibleIds.add(stop.spot.id);
        }
      }
    });
  }
  const planKey = plan
    ? `${plan.activeDay}:${plan.days
        .map((d) => d.stops.map((s) => s.spot.id).join(","))
        .join("|")}:${plan.stay?.lat ?? ""}`
    : "";

  // Sync pill markers with spots
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const spot of spots) {
      const isSelected = spot.id === selectedId;
      const isHighlighted =
        highlightVideoId != null &&
        spot.mentions.some((m) => m.videoId === highlightVideoId);
      // A numbered day pin replaces the pill; in unassigned view the planned
      // pills dim; in a day view the other days' pills dim too.
      const planHidden = planVisibleIds.has(spot.id);
      const planDimmed =
        !planHidden &&
        plan != null &&
        (plan.activeDay === "unassigned"
          ? planAllIds.has(spot.id)
          : plan.activeDay !== "all" && !isSelected);
      const isDimmed =
        (highlightVideoId != null && !isHighlighted) || planDimmed;
      const pillClass = [
        "pin-pill",
        isSelected ? "selected" : "",
        isHighlighted ? "highlight" : "",
        isDimmed ? "dimmed" : "",
        planHidden ? "plan-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ");
      // Compact by default (emoji + count) so pins don't collide into an
      // unreadable pile; the name label expands on hover / select / highlight.
      const star = mustSeeIds.includes(spot.id)
        ? `<span class="pin-star">⭐</span>`
        : "";
      const html = `<div class="${pillClass}">${star}<span class="pin-emoji">${
        CATEGORY_EMOJI[spot.category]
      }</span><span class="pin-name">${escapeHtml(shorten(spot.name))}</span>${
        spot.mentions.length > 1 ? `<span class="pin-count">×${spot.mentions.length}</span>` : ""
      }</div>`;

      const icon = L.divIcon({
        className: "",
        html,
        iconSize: undefined,
        iconAnchor: [0, 0],
      });

      const zIndex = isSelected ? 1000 : isHighlighted ? 800 : spot.mentions.length * 10;
      const existing = markersRef.current.get(spot.id);
      if (existing) {
        existing.setIcon(icon);
        existing.setZIndexOffset(zIndex);
      } else {
        const marker = L.marker([spot.lat, spot.lng], {
          icon,
          zIndexOffset: zIndex,
        });
        marker.on("click", () => onSelect(spot.id));
        marker.addTo(map);
        markersRef.current.set(spot.id, marker);
      }
    }

    // Remove markers for deleted spots
    for (const [id, marker] of markersRef.current) {
      if (!spots.some((s) => s.id === id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }

    // Fit bounds once when we first have spots (after the container has settled)
    if (!fittedRef.current && spots.length > 0) {
      fittedRef.current = true;
      const bounds = L.latLngBounds(spots.map((s) => [s.lat, s.lng] as [number, number]));
      requestAnimationFrame(() => {
        if (mapRef.current !== map) return; // map was torn down (StrictMode remount)
        map.invalidateSize();
        map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
      });
    }
    // planKey covers everything the pill classes read from `plan`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spots, selectedId, highlightVideoId, onSelect, planKey, mustSeeIds.join(",")]);

  // Draw the plan overlay: numbered pins in day colors + a route line per day.
  useEffect(() => {
    const layer = planLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!plan) return;

    plan.days.forEach((day, i) => {
      if (plan.activeDay !== "all" && plan.activeDay !== i) return;
      if (day.stops.length === 0) return;

      const latlngs = day.stops.map(
        (s) => [s.spot.lat, s.spot.lng] as [number, number]
      );
      if (latlngs.length > 1) {
        L.polyline(latlngs, {
          color: day.color,
          weight: 3,
          opacity: 0.75,
          dashArray: "6 8",
          lineCap: "round",
        }).addTo(layer);
      }

      day.stops.forEach((stop, order) => {
        const icon = L.divIcon({
          className: "",
          html: `<div class="day-pin" style="background:${day.color}" title="${escapeHtml(
            `${day.label} · ${order + 1}. ${stop.spot.name}`
          )}"><span class="day-pin-n">${order + 1}</span><span class="day-pin-name">${escapeHtml(
            shorten(stop.spot.name)
          )}</span></div>`,
          iconSize: undefined,
          iconAnchor: [13, 13],
        });
        const marker = L.marker([stop.spot.lat, stop.spot.lng], {
          icon,
          zIndexOffset: 1200 + order,
        });
        marker.on("click", () => onSelect(stop.spot.id));
        marker.addTo(layer);
      });
    });

    if (
      plan.stay &&
      typeof plan.stay.lat === "number" &&
      typeof plan.stay.lng === "number" &&
      plan.activeDay !== "unassigned"
    ) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="stay-pin" title="${escapeHtml(plan.stay.name)}">🏠</div>`,
        iconSize: undefined,
        iconAnchor: [15, 15],
      });
      L.marker([plan.stay.lat, plan.stay.lng], {
        icon,
        zIndexOffset: 1500,
      }).addTo(layer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, onSelect]);

  // Selecting a day chip fits the viewport to that day's route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !plan || typeof plan.activeDay !== "number") return;
    const day = plan.days[plan.activeDay];
    if (!day || day.stops.length === 0) return;
    const pts = day.stops.map((s) => [s.spot.lat, s.spot.lng] as [number, number]);
    if (plan.stay?.lat != null && plan.stay?.lng != null) {
      pts.push([plan.stay.lat, plan.stay.lng]);
    }
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 15, animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.activeDay]);

  // When a video is pinned, fit the viewport to all of its spots — zooming
  // out (or in) so none of them are off-screen. Hover alone never moves the
  // map; spots live in a ref so a background poll doesn't re-trigger the fit.
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitVideoId) return;
    const videoSpots = spotsRef.current.filter((s) =>
      s.mentions.some((m) => m.videoId === fitVideoId)
    );
    if (videoSpots.length === 0) return;
    const bounds = L.latLngBounds(
      videoSpots.map((s) => [s.lat, s.lng] as [number, number])
    );
    map.fitBounds(bounds.pad(0.2), { maxZoom: 14, animate: true });
  }, [fitVideoId]);

  // Pan to selected spot
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const spot = spots.find((s) => s.id === selectedId);
    if (spot) map.panTo([spot.lat, spot.lng], { animate: true });
  }, [selectedId, spots]);

  // Mini photo popup on the selected spot — the detail card is in the page's
  // right rail, so the map just shows a glanceable photo + name.
  const popupRef = useRef<L.Popup | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = null;
    if (!popupSpot) return;
    const html = `<div class="spot-pop-inner">${
      popupSpot.photoUrl
        ? `<img src="${escapeHtml(popupSpot.photoUrl)}" alt="" />`
        : ""
    }<div class="spot-pop-meta"><div class="spn">${escapeHtml(
      popupSpot.name
    )}</div><div class="sps">${escapeHtml(popupSpot.sub)}</div></div></div>`;
    popupRef.current = L.popup({
      closeButton: false,
      className: "spot-pop",
      offset: [0, -6],
      autoPan: true,
      maxWidth: 230,
    })
      .setLatLng([popupSpot.lat, popupSpot.lng])
      .setContent(html)
      .openOn(map);
    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupSpot?.id, popupSpot?.photoUrl]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

function shorten(name: string) {
  return name.length > 26 ? name.slice(0, 24) + "…" : name;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
