/**
 * Shared Anthropic client with PostHog LLM analytics.
 *
 * Every call goes through `observedMessage`, which captures one
 * `$ai_generation` event — PostHog's native LLM-analytics schema, the same
 * events its `@posthog/ai` wrapper emits. We capture manually because that
 * wrapper pins @anthropic-ai/sdk to ^0.78 and this app needs 0.104+
 * (output_config / zodOutputFormat). Without POSTHOG_API_KEY, calls pass
 * straight through and nothing is sent.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "async_hooks";
import { PostHog } from "posthog-node";

export const client = new Anthropic();

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      // `||`, not `??` — an unset key in a .env file is "" , not undefined, and an
      // empty host silently sends every analytics event nowhere.
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      // Serverless: send per-event instead of batching — a frozen function
      // never fires the interval flush.
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

/** Which trip a call belongs to — set as event properties so traces can be
 *  filtered and cost summed per itinerary. */
export type TripTag = {
  tripId?: string;
  tripName?: string;
};

// --- User attribution -------------------------------------------------------
// With accounts, generations are keyed to the signed-in user (distinctId +
// person profile) so PostHog can slice cost/usage per user and build cohorts.
// The user comes from the session cookie SERVER-side (never a client-sent
// field — that would be spoofable) and rides request-scoped AsyncLocalStorage
// so deep pipeline code (extract, discover) needs no signature changes.

export type LlmUser = {
  id: string; // "google:<sub>" | "dev:local"
  email?: string | null;
  name?: string | null;
};

const llmUserStore = new AsyncLocalStorage<LlmUser | null>();

/** Route handlers wrap their LLM work in this so every capture inside is
 *  attributed to the signed-in user (pass null for anonymous callers). */
export function withLlmUser<T>(user: LlmUser | null, fn: () => Promise<T>): Promise<T> {
  return llmUserStore.run(user, fn);
}

/** distinctId + person/event properties for the current request's user.
 *  Anonymous: key by trace, skip person profiles (the pre-accounts behavior). */
export function userAttribution(fallbackDistinctId: string): {
  distinctId: string;
  properties: Record<string, unknown>;
} {
  const user = llmUserStore.getStore() ?? null;
  if (!user) {
    return {
      distinctId: fallbackDistinctId,
      properties: { $process_person_profile: false },
    };
  }
  return {
    distinctId: user.id,
    properties: {
      userId: user.id,
      ...(user.email || user.name
        ? {
            $set: {
              ...(user.email ? { email: user.email } : {}),
              ...(user.name ? { name: user.name } : {}),
            },
          }
        : {}),
    },
  };
}

export type LlmCallOptions = {
  /** Label shown on the generation in PostHog's trace view. */
  spanName: string;
  /** Groups related generations into one trace (e.g. plan + curate). */
  traceId: string;
  /** Use the streaming API — required when max_tokens is large. */
  stream?: boolean;
  /** Extra event properties, e.g. { destination, videoId }. */
  properties?: Record<string, string | number | boolean | null>;
};

/** TripTag -> event properties, skipping absent fields. */
export function tripProperties(trip?: TripTag): Record<string, string> {
  return {
    ...(trip?.tripId ? { tripId: trip.tripId } : {}),
    ...(trip?.tripName ? { tripName: trip.tripName } : {}),
  };
}

/** Sanitize a client-supplied trip tag: strings only, capped length. */
export function parseTripTag(body: Record<string, unknown>): TripTag {
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  return {
    tripId: str(body.tripId, 64),
    tripName: str(body.tripName, 200),
  };
}

// PostHog drops events over ~1MB and transcript prompts can be hundreds of
// KB — keep the debugging value, cap the payload.
const MAX_CONTENT_CHARS = 50_000;

function truncate(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? `${text.slice(0, MAX_CONTENT_CHARS)}… [truncated ${text.length - MAX_CONTENT_CHARS} chars]`
    : text;
}

function formatInput(params: Anthropic.MessageCreateParamsNonStreaming) {
  const input: { role: string; content: string }[] = [];
  if (typeof params.system === "string") {
    input.push({ role: "system", content: truncate(params.system) });
  }
  for (const m of params.messages) {
    input.push({
      role: m.role,
      content: truncate(
        typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      ),
    });
  }
  return input;
}

function errorStatus(error: unknown): number {
  return error instanceof Anthropic.APIError && typeof error.status === "number"
    ? error.status
    : 500;
}

async function captureGeneration(
  opts: LlmCallOptions,
  params: Anthropic.MessageCreateParamsNonStreaming,
  latencySec: number,
  message?: Anthropic.Message,
  error?: unknown
): Promise<void> {
  if (!posthog) return;
  try {
    const usage = message?.usage;
    const outputText = message?.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const who = userAttribution(opts.traceId);
    posthog.capture({
      // Signed-in: keyed to the account (person profile + cohorts). Anonymous:
      // keyed by trace with person processing off, as before accounts.
      distinctId: who.distinctId,
      event: "$ai_generation",
      properties: {
        ...who.properties,
        $ai_provider: "anthropic",
        $ai_model: message?.model ?? params.model,
        $ai_model_parameters: { max_tokens: params.max_tokens },
        $ai_input: formatInput(params),
        ...(outputText !== undefined
          ? {
              $ai_output_choices: [
                { role: "assistant", content: truncate(outputText) },
              ],
            }
          : {}),
        $ai_input_tokens: usage?.input_tokens ?? 0,
        $ai_output_tokens: usage?.output_tokens ?? 0,
        ...(usage?.cache_read_input_tokens
          ? { $ai_cache_read_input_tokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage?.cache_creation_input_tokens
          ? { $ai_cache_creation_input_tokens: usage.cache_creation_input_tokens }
          : {}),
        $ai_latency: latencySec,
        $ai_http_status: error ? errorStatus(error) : 200,
        $ai_trace_id: opts.traceId,
        $ai_span_name: opts.spanName,
        $ai_base_url: client.baseURL,
        ...(message?.stop_reason ? { $ai_stop_reason: message.stop_reason } : {}),
        ...(error ? { $ai_is_error: true, $ai_error: String(error) } : {}),
        ...opts.properties,
      },
    });
    // Await delivery so a serverless freeze can't drop the event; ~ms next to
    // a multi-second LLM call.
    await posthog.flush();
  } catch (err) {
    // Telemetry must never break the pipeline.
    console.warn(
      "[posthog] capture failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * `messages.create` (or `.stream()` + `finalMessage()` when `stream: true`)
 * with a `$ai_generation` event captured around it — success or failure.
 */
export async function observedMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: LlmCallOptions
): Promise<Anthropic.Message> {
  const start = Date.now();
  try {
    const message = opts.stream
      ? await client.messages.stream(params).finalMessage()
      : await client.messages.create(params);
    await captureGeneration(opts, params, (Date.now() - start) / 1000, message);
    return message;
  } catch (error) {
    await captureGeneration(
      opts,
      params,
      (Date.now() - start) / 1000,
      undefined,
      error
    );
    throw error;
  }
}
