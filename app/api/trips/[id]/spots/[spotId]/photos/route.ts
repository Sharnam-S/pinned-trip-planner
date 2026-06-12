import { NextRequest, NextResponse } from "next/server";
import { resolveMorePhotos } from "@/lib/pipeline";

export const runtime = "nodejs";

/** First carousel swipe on a spot tile — resolve its remaining photos. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; spotId: string }> }
) {
  const { id, spotId } = await params;
  const urls = await resolveMorePhotos(id, spotId);
  if (urls === null) {
    return NextResponse.json({ error: "Spot not found" }, { status: 404 });
  }
  return NextResponse.json({ urls });
}
