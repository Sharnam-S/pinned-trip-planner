/**
 * Tiny per-IP daily rate limiter for the public compute endpoints — the
 * Anthropic/Google keys are ours, so a stranger hammering the API should hit
 * a wall. In-memory only: resets on cold start and isn't shared across
 * serverless instances, so treat the limits as generous safety caps, not
 * precise accounting.
 */
const buckets = new Map<string, { day: string; count: number }>();

export function rateLimit(req: Request, kind: string, limit: number): boolean {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const day = new Date().toISOString().slice(0, 10);
  const key = `${kind}:${ip}`;
  const b = buckets.get(key);
  if (!b || b.day !== day) {
    buckets.set(key, { day, count: 1 });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

export function rateLimited() {
  return Response.json(
    { error: "Daily limit reached for now — try again tomorrow." },
    { status: 429 }
  );
}
