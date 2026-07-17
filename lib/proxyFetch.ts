import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { RequestInfo, RequestInit as UndiciRequestInit } from "undici";

/**
 * YouTube bot-checks and blocks requests coming from Vercel's shared datacenter
 * IPs — that is why transcript (and search) fetches work locally but fail once
 * deployed. Routing every YouTube-bound request (InnerTube search/info, the
 * BotGuard challenge, caption downloads, oEmbed) through a residential proxy
 * makes them originate from a trusted IP instead.
 *
 * Set YOUTUBE_PROXY_URL to any standard proxy URL, e.g.
 *   http://user:pass@host:port
 * (works with Bright Data, Oxylabs, Webshare, IPRoyal, … residential plans).
 *
 * Unset — as in local dev — requests go out directly through the global fetch,
 * so behaviour is exactly what it is today.
 */
const proxyUrl = process.env.YOUTUBE_PROXY_URL;

export const proxyEnabled = Boolean(proxyUrl);

// One dispatcher per process (holds the proxy connection pool). Lazily created
// so nothing is allocated when no proxy is configured.
let dispatcher: ProxyAgent | undefined;

/**
 * undici's fetch can't consume a global `Request` object — it belongs to a
 * different class and stringifies to "[object Request]", which undici then
 * fails to parse as a URL. youtubei.js calls fetch with exactly that: a Request
 * carrying the InnerTube POST body. So when we get one, unpack it (url, method,
 * headers, body, signal) into an init undici accepts. A plain string/URL passes
 * straight through. Node's own global fetch (used when no proxy) handles either
 * natively, so this shim only exists on the proxied path.
 */
async function proxiedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  dispatcher ??= new ProxyAgent(proxyUrl!);

  if (input instanceof Request) {
    const hasBody = input.method !== "GET" && input.method !== "HEAD";
    const reqInit: UndiciRequestInit = {
      method: input.method,
      headers: input.headers as unknown as UndiciRequestInit["headers"],
      body: hasBody ? await input.arrayBuffer() : undefined,
      signal: input.signal as UndiciRequestInit["signal"],
      ...(init as unknown as UndiciRequestInit),
      dispatcher,
    };
    return undiciFetch(input.url, reqInit) as unknown as Promise<Response>;
  }

  return undiciFetch(input as unknown as RequestInfo, {
    ...(init as unknown as UndiciRequestInit),
    dispatcher,
  }) as unknown as Promise<Response>;
}

export const ytFetch: typeof fetch = proxyUrl
  ? (proxiedFetch as unknown as typeof fetch)
  : globalThis.fetch;
