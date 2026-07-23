import { NextRequest, NextResponse } from "next/server";
import {
  DEV_USER,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  authEnabled,
  devAuthActive,
  safeNextPath,
  sessionCookieOptions,
  signOAuthState,
  signSession,
} from "@/lib/auth";
import { upsertUser } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Starts sign-in: redirects to Google's consent screen (state + nonce carried
 * in a short-lived signed cookie). In local dev without Google credentials it
 * signs in the built-in Dev User directly, so the flow stays testable offline.
 * `?next=/some/path` is where the browser lands after the round trip.
 */
export async function GET(req: NextRequest) {
  if (!authEnabled()) {
    return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  }
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));

  if (devAuthActive()) {
    await upsertUser(DEV_USER);
    const res = NextResponse.redirect(new URL(next, req.nextUrl.origin));
    res.cookies.set(SESSION_COOKIE, await signSession(DEV_USER), sessionCookieOptions());
    return res;
  }

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  authUrl.searchParams.set("redirect_uri", `${req.nextUrl.origin}/api/auth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(OAUTH_COOKIE, await signOAuthState({ state, nonce, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
