/**
 * Sessions + Google SSO plumbing. Deliberately hand-rolled (standard OIDC
 * authorization-code flow + a jose-signed JWT in an httpOnly cookie) instead
 * of an auth framework: two small routes, no framework-version coupling, and
 * the session never touches localStorage where injected scripts could read it.
 *
 * Three modes, decided by env (see .env.example):
 *  - Google configured  -> real SSO.
 *  - Local dev, no creds -> a built-in "Dev User" signs in instantly, so the
 *    whole multi-user flow is testable offline.
 *  - Vercel, no creds    -> auth disabled; the app keeps the old
 *    single-user, localStorage-only behavior.
 */
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { dbEnabled, DbUser } from "./db";

export const SESSION_COOKIE = "pinned_session";
export const OAUTH_COOKIE = "pinned_oauth"; // state/nonce/next during the redirect
const SESSION_DAYS = 30;

const isProd = process.env.NODE_ENV === "production";

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Instant fake sign-in for local dev — never active in production builds. */
export function devAuthActive(): boolean {
  return !isProd && !googleConfigured() && dbEnabled();
}

export function authEnabled(): boolean {
  return (googleConfigured() && dbEnabled() && Boolean(sessionSecret())) || devAuthActive();
}

function sessionSecret(): string | null {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  // Dev-only fallback so `npm run dev` works with an empty .env.local. A
  // production deploy must set AUTH_SECRET (authEnabled() is false otherwise).
  return isProd ? null : "pinned-dev-only-secret-do-not-use-in-prod";
}

function key(): Uint8Array {
  const secret = sessionSecret();
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return new TextEncoder().encode(secret);
}

export interface SessionUser {
  id: string; // "google:<sub>" | "dev:local"
  email: string;
  name: string | null;
  picture: string | null;
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(key());
}

/** Short-lived signed blob carried across the Google redirect. */
export async function signOAuthState(payload: {
  state: string;
  nonce: string;
  next: string;
}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key());
}

export async function verifyOAuthState(
  token: string
): Promise<{ state: string; nonce: string; next: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    return {
      state: String(payload.state ?? ""),
      nonce: String(payload.nonce ?? ""),
      next: String(payload.next ?? "/"),
    };
  } catch {
    return null;
  }
}

/** The signed-in user, or null. Safe to call from any route handler. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!authEnabled()) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (typeof payload.id !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return {
      id: payload.id,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : null,
      picture: typeof payload.picture === "string" ? payload.picture : null,
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

/** Overridable so a local session can carry a named identity — which is what
 *  makes a scripted product pass show up in PostHog as a real person instead of
 *  an anonymous trace. Dev-only: devAuthActive() is false in production. */
export const DEV_USER: DbUser = {
  id: process.env.DEV_USER_ID || "dev:local",
  email: process.env.DEV_USER_EMAIL || "dev@localhost",
  name: process.env.DEV_USER_NAME || "Dev User",
  picture: null,
};

/** Only same-site relative paths may be redirect targets after sign-in. */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}
