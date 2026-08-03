/**
 * Tiny per-IP daily rate limiter for the public compute endpoints — the
 * Anthropic/Google keys are ours, so a stranger hammering the API should hit
 * a wall. In-memory only: resets on cold start and isn't shared across
 * serverless instances, so treat the limits as generous safety caps, not
 * precise accounting.
 */
const buckets = new Map<string, { day: string; count: number }>();

/**
 * `userId` (when signed in) is a far better bucket than the IP: an office, a
 * café or a family behind one NAT used to share a single allowance, so one
 * person planning a few trips could lock out everyone around them. Trips belong
 * to accounts now, so charge the account. Anonymous callers still fall back to
 * the IP — it's all we have.
 */
export function rateLimit(
  req: Request,
  kind: string,
  limit: number,
  userId?: string | null
): boolean {
  const who =
    userId ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  const day = new Date().toISOString().slice(0, 10);
  const key = `${kind}:${who}`;
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
