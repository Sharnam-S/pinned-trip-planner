import { NextResponse } from "next/server";
import { listTrips } from "@/lib/store";

export const runtime = "nodejs";

/**
 * Sample trips committed to the repo, shown to every visitor. Trips people
 * create live in their own browser's localStorage — the server never stores
 * them (see lib/clientStore.ts and lib/runner.ts).
 */
export async function GET() {
  return NextResponse.json(listTrips());
}
