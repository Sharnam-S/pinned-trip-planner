"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Spot } from "@/lib/types";

// A pretty default (old Tbilisi) so the hero is never an empty grey box
// before the first trip exists.
const FALLBACK_CENTER: [number, number] = [41.6938, 44.8015];

export default function HeroMap({ spots }: { spots: Spot[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  // Init once — a non-interactive, slowly drifting backdrop
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: FALLBACK_CENTER,
      zoom: 14,
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    });
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
    };
  }, []);

  // Frame the trip's city once — a calm, static backdrop. No pins, no motion.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || spots.length === 0) return;
    const bounds = L.latLngBounds(spots.map((s) => [s.lat, s.lng] as [number, number]));
    requestAnimationFrame(() => {
      if (mapRef.current !== map) return;
      map.invalidateSize();
      map.fitBounds(bounds.pad(0.25), { maxZoom: 13, animate: false });
    });
  }, [spots]);

  return <div ref={containerRef} className="hero-map" />;
}
