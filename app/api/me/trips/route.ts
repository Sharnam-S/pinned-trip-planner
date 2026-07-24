import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listTripSummaries } from "@/lib/db";

export const runtime = "nodejs";

/** The signed-in user's trips, dashboard-sized (no spot/video payloads). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  try {
    return NextResponse.json(await listTripSummaries(user.id));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load trips." },
      { status: 500 }
    );
  }
}
