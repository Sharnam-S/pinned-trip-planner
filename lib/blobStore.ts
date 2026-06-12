/**
 * Shared trip library, backed by Vercel Blob. This is the one source of
 * truth that both the localhost app and the deployed site read from: trips
 * you build on localhost auto-publish here (lib/runner.ts), /uploadtrip
 * writes here, and everyone's "Trips" gallery lists from here.
 *
 * Server-side only — the read/write token (BLOB_READ_WRITE_TOKEN) must never
 * reach the browser, so all access goes through the /api routes.
 */
import { del, list, put } from "@vercel/blob";
import { Trip } from "./types";

const PREFIX = "trips/";
const pathFor = (id: string) => `${PREFIX}${id}.json`;

export function blobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function publishTripToBlob(trip: Trip): Promise<void> {
  await put(pathFor(trip.id), JSON.stringify(trip), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true, // republish overwrites (e.g. after adding videos)
    cacheControlMaxAge: 0, // always serve the latest on the next read
  });
}

export async function deleteTripFromBlob(id: string): Promise<void> {
  await del(pathFor(id));
}

export async function listBlobTrips(): Promise<Trip[]> {
  if (!blobEnabled()) return [];
  const { blobs } = await list({ prefix: PREFIX });
  const trips = await Promise.all(
    blobs.map(async (b) => {
      try {
        const res = await fetch(b.url, { cache: "no-store" });
        return res.ok ? ((await res.json()) as Trip) : null;
      } catch {
        return null;
      }
    })
  );
  return trips.filter((t): t is Trip => t !== null);
}

export async function getBlobTrip(id: string): Promise<Trip | null> {
  if (!blobEnabled()) return null;
  const { blobs } = await list({ prefix: pathFor(id), limit: 1 });
  const hit = blobs.find((b) => b.pathname === pathFor(id));
  if (!hit) return null;
  try {
    const res = await fetch(hit.url, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Trip) : null;
  } catch {
    return null;
  }
}
