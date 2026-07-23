import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Live map search for the trip page. Proxies OpenStreetMap Nominatim so the
 * required User-Agent is set server-side (browsers can't) and results can be
 * edge-cached — the client debounces, and repeated queries are served for free.
 *
 * `viewbox` (left,top,right,bottom around the trip) biases results toward the
 * destination without excluding elsewhere, so "beach" surfaces a nearby beach
 * before a same-named one across the world.
 */

interface NominatimItem {
  place_id: number;
  name?: string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string]; // south, north, west, east
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 3) return NextResponse.json([]);

  const viewbox = req.nextUrl.searchParams.get("viewbox");
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    q,
    "accept-language": "en",
  });
  // bounded=0 → bias, don't restrict.
  if (viewbox && /^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(viewbox)) {
    params.set("viewbox", viewbox);
    params.set("bounded", "0");
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          "User-Agent": "youtube-trip-planner/1.0 (map search)",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const items = (await res.json()) as NominatimItem[];

    const places = items.map((it) => {
      const lat = parseFloat(it.lat);
      const lng = parseFloat(it.lon);
      // Trim the long OSM display name to the first couple of parts for a
      // readable primary label; keep the rest as the muted sub-line.
      const parts = it.display_name.split(",").map((p) => p.trim());
      const name = it.name || parts[0] || it.display_name;
      const bb = it.boundingbox;
      const bounds =
        bb && bb.length === 4
          ? ([
              [parseFloat(bb[0]), parseFloat(bb[2])],
              [parseFloat(bb[1]), parseFloat(bb[3])],
            ] as [[number, number], [number, number]])
          : null;
      return {
        id: String(it.place_id),
        name,
        label: parts.slice(1).join(", ") || it.display_name,
        lat,
        lng,
        bounds,
      };
    });

    return NextResponse.json(places, {
      headers: { "Cache-Control": "public, s-maxage=86400, max-age=3600" },
    });
  } catch {
    return NextResponse.json([]);
  }
}
