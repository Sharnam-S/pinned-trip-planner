/**
 * Feedback and build-this prompts from the trip page.
 *
 * Two sinks on purpose, because they answer different needs and either can be
 * absent: Postgres is the durable, readable record (`scripts/read-feedback.mts`),
 * PostHog is where the team already looks and is the only sink on a deploy with
 * no DATABASE_URL. A submission succeeds if EITHER lands — someone who just
 * typed three paragraphs should not be told to try again because one of our
 * stores is misconfigured.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { captureFeedback } from "@/lib/analytics";
import { dbEnabled, insertFeedback } from "@/lib/db";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Long enough for a dictated prompt to run on — a Wispr-style pass over "here
 *  is everything I want changed" lands well inside this — and short enough that
 *  the endpoint can't be used as free storage. */
const MAX_MESSAGE = 8000;
const MAX_CONTACT = 200;
const MAX_TRIP_NAME = 200;

/** Below this it's a stray keypress or a test, not something anyone will act
 *  on. Kept in sync with the button's disabled state so the UI never offers a
 *  submit the server will refuse. */
const MIN_MESSAGE = 4;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  // Generous: this is a human typing, not a compute endpoint. It exists so a
  // script can't fill the table overnight.
  if (!rateLimit(req, "feedback", 30, user?.id)) return rateLimited();

  const body = await req.json().catch(() => ({}));
  const kind = body?.kind === "prompt" ? "prompt" : "feedback";
  const message = str(body?.message, MAX_MESSAGE);
  if (message.length < MIN_MESSAGE) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }
  const meta = {
    contact: str(body?.contact, MAX_CONTACT) || null,
    tripId: str(body?.tripId, 100) || null,
    tripName: str(body?.tripName, MAX_TRIP_NAME) || null,
  };

  let stored = false;
  if (dbEnabled()) {
    try {
      await insertFeedback({
        kind,
        message,
        ...meta,
        userId: user?.id ?? null,
        userEmail: user?.email ?? null,
      });
      stored = true;
    } catch (err) {
      // Logged, not returned: PostHog may still take it, and the sender doesn't
      // need our storage problems.
      console.error(
        "[feedback] db write failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  let captured = false;
  try {
    await captureFeedback(
      kind,
      message,
      { ...meta, stored },
      user,
      typeof body?.distinctId === "string" ? body.distinctId : null
    );
    captured = Boolean(process.env.POSTHOG_API_KEY);
  } catch (err) {
    console.error(
      "[feedback] capture failed:",
      err instanceof Error ? err.message : err
    );
  }

  if (!stored && !captured) {
    return NextResponse.json(
      { error: "Couldn't record that — nothing is configured to receive it." },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, stored });
}
