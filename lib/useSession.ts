"use client";

/**
 * Client-side view of the session. One /api/me fetch per page load, shared by
 * every component via a module-level cache (the session only changes through
 * full-page redirects — sign-in and sign-out — so there's nothing to
 * re-validate mid-session).
 */
import { useEffect, useState } from "react";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface SessionState {
  /** true until /api/me answers — render neither hero nor dashboard yet. */
  loading: boolean;
  /** false = this deploy has no auth configured; keep the legacy flow. */
  enabled: boolean;
  user: SessionUser | null;
}

let cached: SessionState | null = null;
let inflight: Promise<SessionState> | null = null;
const listeners = new Set<(s: SessionState) => void>();

function fetchSession(): Promise<SessionState> {
  if (!inflight) {
    inflight = fetch("/api/me")
      .then((r) => r.json())
      .then((data) => ({
        loading: false,
        enabled: Boolean(data.enabled),
        user: (data.user as SessionUser) ?? null,
      }))
      .catch(() => ({ loading: false, enabled: false, user: null }))
      .then((state: SessionState) => {
        cached = state;
        listeners.forEach((l) => l(state));
        return state;
      });
  }
  return inflight;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(
    cached ?? { loading: true, enabled: false, user: null }
  );
  useEffect(() => {
    if (cached) return;
    listeners.add(setState);
    void fetchSession();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** Await-able session for non-React code (the sync layer). */
export function getSession(): Promise<SessionState> {
  return cached ? Promise.resolve(cached) : fetchSession();
}

export function signIn(next: string = "/") {
  window.location.href = `/api/auth/login?next=${encodeURIComponent(next)}`;
}

export async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // even if the request failed, reload — the server will still see a cookie
  }
  window.location.href = "/";
}
