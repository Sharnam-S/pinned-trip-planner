import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getChat, putChat } from "@/lib/db";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";

// Mirrors the localStorage cap (80 messages) with headroom; the payload is
// UIMessage JSON, so a hard byte cap guards against runaway parts.
const MAX_MESSAGES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The planner conversation for an owned trip. The chat route itself stays
 * stateless (tools execute client-side, the browser holds the final message
 * state) — so persistence mirrors the client's debounced localStorage save:
 * the browser PUTs the sanitized message array, and a fresh device GETs it.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  try {
    const chat = await getChat(id, user.id);
    return NextResponse.json(chat ?? { messages: null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load the chat." },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!rateLimit(req, "chat-save", 120)) return rateLimited();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ error: "Chat is too large." }, { status: 413 });
  }
  let messages: unknown;
  try {
    messages = (JSON.parse(raw) as { messages?: unknown }).messages;
  } catch {
    messages = null;
  }
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "Bad chat payload." }, { status: 400 });
  }

  const { id } = await params;
  try {
    const ok = await putChat(id, user.id, messages);
    if (!ok) {
      // no such trip in this account yet — the trip push will land first;
      // the client just retries on the next debounce tick
      return NextResponse.json({ error: "Trip not saved yet." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save the chat." },
      { status: 500 }
    );
  }
}

/** Same handler for `navigator.sendBeacon`, which the client uses to flush the
 *  last turn as the page unloads — beacons are always POST, and it's the only
 *  transport that survives the document going away. */
export const POST = PUT;
