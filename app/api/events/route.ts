import { NextRequest, NextResponse, after } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  captureProductEvent,
  isProductEvent,
  sanitizeProps,
} from "@/lib/analytics";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Product-event sink. The browser knows things the server never sees — that a
 * build finished, that the first pin appeared, that a question card was
 * abandoned — so it posts them here and this route captures them with the
 * session's identity attached.
 *
 * Always answers 204, including for events it drops: analytics must never be
 * something a client has to handle. `after()` keeps the function alive past the
 * response so the flush actually happens (the same trap the chat route hit —
 * a serverless function can freeze the moment the response closes).
 */
export async function POST(req: NextRequest) {
  // Generous: this is one small event per meaningful action, and dropping real
  // events to punish a flood would defeat the point. Still bounded.
  if (!rateLimit(req, "events", 2000)) return new NextResponse(null, { status: 204 });

  const body = await req.json().catch(() => null);
  if (!body || !isProductEvent(body.event)) {
    return new NextResponse(null, { status: 204 });
  }

  const user = await getSessionUser();
  const props = sanitizeProps(body.properties);
  // Client-supplied, so shape-checked before it becomes an identity.
  const clientDistinctId =
    typeof body.distinctId === "string" && body.distinctId.length <= 200
      ? body.distinctId
      : null;
  after(captureProductEvent(body.event, props, user, clientDistinctId));
  return new NextResponse(null, { status: 204 });
}
