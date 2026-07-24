import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SessionUser,
  googleConfigured,
  safeNextPath,
  sessionCookieOptions,
  signSession,
  verifyOAuthState,
} from "@/lib/auth";
import { upsertUser } from "@/lib/db";

export const runtime = "nodejs";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

/**
 * Finishes Google sign-in: checks the state we minted at /login, exchanges
 * the code, verifies the id_token signature/audience/nonce against Google's
 * JWKS, upserts the user, and sets the session cookie.
 */
export async function GET(req: NextRequest) {
  const fail = (reason: string) =>
    NextResponse.redirect(
      new URL(`/?auth_error=${encodeURIComponent(reason)}`, req.nextUrl.origin)
    );

  if (!googleConfigured()) return fail("Sign-in is not configured.");

  const stashed = req.cookies.get(OAUTH_COOKIE)?.value;
  const expected = stashed ? await verifyOAuthState(stashed) : null;
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!expected || !code || !state || state !== expected.state) {
    return fail("Sign-in expired — please try again.");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${req.nextUrl.origin}/api/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail("Google rejected the sign-in.");
  const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
  if (!idToken) return fail("Google returned no identity.");

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: process.env.GOOGLE_CLIENT_ID!,
    }));
  } catch {
    return fail("Could not verify the Google identity.");
  }
  if (claims.nonce !== expected.nonce || typeof claims.sub !== "string") {
    return fail("Could not verify the Google identity.");
  }

  const user: SessionUser = {
    id: `google:${claims.sub}`,
    email: typeof claims.email === "string" ? claims.email : "",
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
  };
  try {
    await upsertUser(user);
  } catch {
    return fail("Could not save your account — try again in a minute.");
  }

  const res = NextResponse.redirect(
    new URL(safeNextPath(expected.next), req.nextUrl.origin)
  );
  res.cookies.set(SESSION_COOKIE, await signSession(user), sessionCookieOptions());
  res.cookies.delete(OAUTH_COOKIE);
  return res;
}
