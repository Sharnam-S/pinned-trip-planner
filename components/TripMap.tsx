"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Destination, Spot } from "@/lib/types";
import { CATEGORY_EMOJI } from "@/lib/categories";

interface Props {
  destination: Destination;
  spots: Spot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function TripMap({ destination, spots, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const fittedRef = useRef(false);

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [destination.lat, destination.lng],
      zoom: destination.zoom,
      zoomControl: true,
      attributionControl: true,
    });
    // CARTO Voyager: the soft pastel look closest to Airbnb's map
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);
    mapRef.current = map;

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
      markersRef.current.clear();
      fittedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync markers with spots
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const spot of spots) {
      const isSelected = spot.id === selectedId;
      const html = `<div class="pin-pill ${isSelected ? "selected" : ""}">${
        CATEGORY_EMOJI[spot.category]
      }<span>${escapeHtml(shorten(spot.name))}</span>${
        spot.mentions.length > 1 ? `<span style="opacity:.6">×${spot.mentions.length}</span>` : ""
      }</div>`;

      const icon = L.divIcon({
        className: "",
        html,
        iconSize: undefined,
        iconAnchor: [0, 0],
      });

      const existing = markersRef.current.get(spot.id);
      if (existing) {
        existing.setIcon(icon);
        existing.setZIndexOffset(isSelected ? 1000 : spot.mentions.length * 10);
      } else {
        const marker = L.marker([spot.lat, spot.lng], {
          icon,
          zIndexOffset: isSelected ? 1000 : spot.mentions.length * 10,
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
  }, [spots, selectedId, onSelect]);

  // Pan to selected spot
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const spot = spots.find((s) => s.id === selectedId);
    if (spot) map.panTo([spot.lat, spot.lng], { animate: true });
  }, [selectedId, spots]);

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
