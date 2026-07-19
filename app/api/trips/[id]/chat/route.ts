/**
 * Planner agent chat — stateless by design. User trips live only in the
 * browser (localStorage), so the client sends the trip context (spot digest +
 * current itinerary) with every request and executes both tools itself
 * (update_itinerary writes localStorage; get_travel_times has the coords).
 * This route just runs the model and streams back text + tool calls.
 */
import { NextRequest } from "next/server";
import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  tool,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { PostHog } from "posthog-node";
import {
  ItineraryInputSchema,
  TravelTimesInputSchema,
  spotDigest,
  type PlannerContext,
} from "@/lib/itinerary";
import { rateLimit, rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";
// Sonnet thinks before it answers, and a multi-day plan is a long think plus
// a large tool-call JSON — 60s got killed mid-stream in production (Vercel
// runtime timeout). Fluid compute allows up to 300s.
export const maxDuration = 300;

const MODEL = "claude-sonnet-5";

const PERSONA = `You are a seasoned local guide helping a traveler turn their saved spots into a day-by-day itinerary. The spots come from YouTube travel videos they researched; each has an id, category, creator mentions, and nearest-neighbor distances.

How you work:
- Propose, don't interrogate. Ask at most 1-2 short questions (only what's truly missing — trip length, budget, or where they're staying), then put a full draft plan on the table and refine from feedback. If dates or interests are already in the trip context, use them without asking.
- EVERY plan or plan change goes through the update_itinerary tool — never describe an itinerary only in prose. The tool replaces the whole plan, so always send every day, not just the changed one.
- Use spot ids exactly as given in the context. Only plan with spots from the context; local knowledge (neighborhoods, timing, transport) goes in day themes and stop notes.
- Cluster days geographically using the "near:" distances — no zig-zagging across the city. Order stops within a day as an efficient route, morning to evening.
- Meals anchor days: place food spots at lunch/dinner positions along the day's route.
- Realistic pacing: 3-5 stops/day balanced, up to 7 packed, 2-3 relaxed. Fewer if spots are far apart. Use get_travel_times when a leg looks long.
- Leave spots out rather than cramming — unplaced spots show as "Unassigned" and the user can ask to swap them in.
- Use each spot's tips (queues, timings, tickets) when ordering the day, and surface the important ones in stop notes.
- ALWAYS write one short sentence BEFORE calling update_itinerary (e.g. "Sketching a 5-day plan around the old town — one moment.") so the user sees progress while the plan streams. Never open a reply with a silent tool call.
- Keep the tool payload lean: stop notes only where they genuinely help (a timing trick, a queue warning), one short sentence each. Most stops need no note.
- After a tool call, keep the prose short: one or two sentences per day on the flow and why, plus your open question if any. The plan itself renders on the user's map.
- If the tool result returns warnings, fix the plan in the same turn.
- If they haven't booked a stay, offer to recommend an area based on where their spots cluster (set it via the stay field).`;

function volatileContext(ctx: PlannerContext): string {
  const parts = [
    `Current itinerary: ${
      ctx.itinerary ? JSON.stringify(ctx.itinerary) : "none yet"
    }`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  return parts.join("\n");
}

function tripHeader(ctx: PlannerContext): string {
  return [
    `Trip: ${ctx.tripName}`,
    ctx.destination ? `Destination: ${ctx.destination}` : null,
    ctx.startDate || ctx.endDate
      ? `Dates: ${ctx.startDate ?? "?"} to ${ctx.endDate ?? "?"}`
      : "Dates: not set",
    ctx.interests ? `Stated interests: ${ctx.interests}` : null,
    "",
    "Spots (id | name | category | mentions | description | tips | nearest neighbors):",
    spotDigest(ctx.spots),
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

// --- PostHog $ai_generation, mirroring lib/llm.ts (which wraps the raw
// Anthropic SDK and can't observe AI SDK calls) ---

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

async function captureGeneration(opts: {
  traceId: string;
  tripId: string;
  tripName: string;
  latencySec: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  outputText: string;
  error?: unknown;
}) {
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: opts.traceId,
      event: "$ai_generation",
      properties: {
        $process_person_profile: false,
        $ai_provider: "anthropic",
        $ai_model: MODEL,
        $ai_input_tokens: opts.inputTokens ?? 0,
        $ai_output_tokens: opts.outputTokens ?? 0,
        ...(opts.cacheRead
          ? { $ai_cache_read_input_tokens: opts.cacheRead }
          : {}),
        ...(opts.cacheWrite
          ? { $ai_cache_creation_input_tokens: opts.cacheWrite }
          : {}),
        $ai_output_choices: [
          { role: "assistant", content: opts.outputText.slice(0, 50_000) },
        ],
        $ai_latency: opts.latencySec,
        $ai_http_status: opts.error ? 500 : 200,
        $ai_trace_id: opts.traceId,
        $ai_span_name: "planner-chat",
        ...(opts.error ? { $ai_is_error: true, $ai_error: String(opts.error) } : {}),
        tripId: opts.tripId,
        tripName: opts.tripName,
      },
    });
    await posthog.flush();
  } catch (err) {
    console.warn(
      "[posthog] capture failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "Planner is not configured on this server (no API key)." },
      { status: 503 }
    );
  }
  if (!rateLimit(req, "planner-chat", 300)) return rateLimited();

  const { id: tripId } = await params;
  const {
    messages,
    context,
    chatSessionId,
  }: {
    messages: UIMessage[];
    context: PlannerContext;
    chatSessionId?: string;
  } = await req.json();

  if (!context?.spots?.length) {
    return Response.json(
      { error: "Missing trip context." },
      { status: 400 }
    );
  }

  const traceId = chatSessionId ?? crypto.randomUUID();
  const start = Date.now();

  const modelMessages: ModelMessage[] = [
    { role: "system", content: PERSONA },
    {
      role: "system",
      content: tripHeader(context),
      // The spot digest is the big static block — cache it so multi-turn
      // sessions only pay full price once. Volatile content goes after.
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    { role: "system", content: volatileContext(context) },
    ...(await convertToModelMessages(messages)),
  ];

  const result = streamText({
    model: anthropic(MODEL),
    messages: modelMessages,
    allowSystemInMessages: true,
    tools: {
      // Client-executed: the browser validates against the real spot list,
      // writes localStorage, and re-renders the map. No execute() here.
      update_itinerary: tool({
        description:
          "Replace the trip's day-by-day itinerary. Send the COMPLETE plan every time (all days), not a diff. The user sees it rendered on their map immediately.",
        inputSchema: ItineraryInputSchema,
      }),
      get_travel_times: tool({
        description:
          "Estimate walking and driving/transit minutes between pairs of spots (straight-line based; good for day planning).",
        inputSchema: TravelTimesInputSchema,
      }),
    },
    onEnd: (event) => {
      void captureGeneration({
        traceId,
        tripId,
        tripName: context.tripName,
        latencySec: (Date.now() - start) / 1000,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheRead: event.usage.inputTokenDetails?.cacheReadTokens,
        cacheWrite: event.usage.inputTokenDetails?.cacheWriteTokens,
        outputText: event.text,
      });
    },
    onError: ({ error }) => {
      void captureGeneration({
        traceId,
        tripId,
        tripName: context.tripName,
        latencySec: (Date.now() - start) / 1000,
        outputText: "",
        error,
      });
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      // Default masks everything as "An error occurred" — surface the real
      // reason so the panel can show something actionable.
      onError: (error) =>
        error instanceof Error ? error.message : String(error ?? "unknown error"),
    }),
  });
}
