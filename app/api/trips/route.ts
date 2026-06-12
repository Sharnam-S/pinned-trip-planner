import { NextResponse } from "next/server";
import { listTrips } from "@/lib/store";
import { listBlobTrips } from "@/lib/blobStore";
import { Trip } from "@/lib/types";

export const runtime = "nodejs";

/**
 * The shared trip library: repo samples plus everything published to the
 * Blob store (trips built on localhost, /uploadtrip shares). Deduped by id,
 * the published copy winning so re-publishes (e.g. after adding videos)
 * supersede a stale sample. The visitor's own in-progress localStorage
 * trips are merged in client-side.
 */
export async function GET() {
  const samples = listTrips();
  const shared = await listBlobTrips().catch(() => [] as Trip[]);
  const byId = new Map<string, Trip>();
  for (const t of samples) byId.set(t.id, t);
  for (const t of shared) byId.set(t.id, t); // published wins
  const all = [...byId.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  return NextResponse.json(all);
}
