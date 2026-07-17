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

export const ytFetch: typeof fetch = proxyUrl
  ? ((input, init) => {
      dispatcher ??= new ProxyAgent(proxyUrl);
      return undiciFetch(input as unknown as RequestInfo, {
        ...(init as unknown as UndiciRequestInit),
        dispatcher,
      }) as unknown as Promise<Response>;
    })
  : globalThis.fetch;
