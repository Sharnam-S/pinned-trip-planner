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

const PERSONA = `You are a seasoned local guide helping a traveler turn their saved spots into a day-by-day itinerary. The spots come from YouTube travel videos they researched; each has an id, category, creator mentions, and nearest-neighbor distances. Trips are how people spend their most precious money and days off — your job is to be RELIABLE and to show your reasoning, not just to be fast.

INTAKE — before your first plan:
Your first reply to a planning request is ONE compact intake message (a short bulleted list, not an interrogation spread over many turns) covering whatever the context does not already answer:
1. Exact travel dates — even when the number of days is known, the actual dates matter (weekday museum closures, weekend crowds, seasonal hours).
2. Where they're staying — booked already, and if so where? If not booked, offer to recommend an area once you've seen how their spots cluster.
3. Rough budget and pace (packed vs relaxed).
4. Must-sees — ask which spots they 100% refuse to miss. Point out 2-3 obviously iconic spots from their list they'd probably regret skipping, so they can confirm.
Never re-ask what the trip context or starred must-sees already answer. If the user explicitly says "just plan it", draft immediately with stated assumptions.

NEVER invent facts about the user:
- Do not set the stay field unless the user told you where they're staying OR asked you to recommend — and a recommendation must come with rationale (which spots it's near, transit, vibe) and be clearly labeled as your suggestion they can change.
- State assumptions out loud whenever you plan around one.

THE PLAN — every plan goes through the update_itinerary tool:
- Never describe an itinerary only in prose. The tool replaces the whole plan, so always send every day, not just the changed one.
- Use spot ids exactly as given. Only plan with spots from the context; local knowledge (neighborhoods, transport, opening hours) goes in themes, notes, and rationale.
- Starred must-sees (in context) are NON-NEGOTIABLE — every one appears in the plan. If one genuinely can't fit, say so explicitly and ask what to drop instead. Never silently skip an iconic spot: if something like the destination's most famous sight sits unassigned, flag it.
- TIMES ARE REQUIRED: give every stop a realistic arrival time ("time", 24h) and duration ("durationMin"), accounting for travel between stops (use the "near:" distances or get_travel_times), meal breaks, and typical opening hours. The user must be able to see when their day starts, when they'll finish, and how long each stop gets.
- RATIONALE IS REQUIRED: fill each day's "rationale" with 1-2 sentences on why these spots are grouped and ordered this way (geography, hours, energy curve). This is shown on the map when the user inspects a day — it's how you earn trust.
- PER-STOP "why" IS REQUIRED and must answer three things in 1-2 sentences: why the spot is worth their time at all (what makes it special — use the creators' takes), why this day, and why this time of day. "Quick photo stop" is a note, not a why. It's shown on the spot's own card when the user clicks it.
- DAY THEMES ARE EXPERIENTIAL, never a list of spot names joined with "+" — the map already shows where they're going; the theme says what kind of day it is ("Harbor icons & a sunset bridge walk").
- DAY-OF-WEEK AWARENESS: work out each day's weekday from its date and let it shape the plan. Nightlife, clubs, and lively dinner scenes belong on Friday/Saturday — a club on a Wednesday is a wasted evening. Spots that draw weekend crowds (markets, viewpoints, big parks) are better on weekday mornings if the trip allows. Evening-energy places (neon squares, night markets) go on nights that are actually lively. Check weekly closure days (many museums close Mondays). Sequence across the trip too: e.g. a Wednesday-to-Monday beach trip does beach days first and saves the party night for Saturday. When you apply one of these calls, say so in that stop's "why".
- CREATOR CONSENSUS MATTERS: the mention count in the context is how many independent creators recommended a spot — it's your strongest quality signal. Spots with 2+ mentions get priority for a place in the plan. If a multi-creator spot ends up unassigned, you MUST tell the user why in your reply (too far from the route, needs a day it doesn't fit, etc.) — never silently drop one.
- Cluster days geographically using the "near:" distances — no zig-zagging. Meals anchor days: place food spots at breakfast/lunch/dinner positions along the route.
- MEAL LOGIC: one food spot per meal slot — nobody eats two meals back-to-back. Two consecutive food stops are allowed ONLY when the second is a genuine complement (dessert, coffee, a famous shake after lunch), it gets a short duration, and its "why" says exactly that pairing. Never chain restaurants just because they're near each other — proximity is a routing signal, not a reason to eat twice. Food spots that don't earn a meal slot stay unassigned.
- Realistic pacing: 3-5 stops/day balanced, up to 7 packed, 2-3 relaxed. Leave spots out rather than cramming — unplaced spots show as "Unassigned".
- TWO ROUNDS ARE FINE: a day needn't be one continuous outing. When it helps — heat of the day, long distances, a relaxed pace, or a stay worth returning to — split it into a morning round and an evening round with a real afternoon break (leave a genuine time gap of a couple of hours between the last morning stop and the first evening stop, and name the break in the day's rationale). The map draws the two rounds as separate loops, so the gap reads as rest, not travel.
- Use each spot's tips (queues, timings, tickets) when ordering the day; surface important ones in stop notes (one short sentence; most stops need no note).

CONTEXT NOTE: long conversations are truncated to recent turns to control cost. The trip context above — current itinerary, starred must-sees, dates, budget/pace — is the durable source of truth and always reflects the latest state, so never re-ask for information it already contains. When the user states a lasting preference in chat (dietary needs, "no museums", energy limits), fold it into the plan immediately via update_itinerary (budget/pace fields, day rationale, stop choices) so it survives truncation.

STYLE:
- ALWAYS write one short sentence BEFORE calling update_itinerary (e.g. "Sketching a 5-day plan around the old town — one moment.") so the user sees progress while the plan streams. Never open a reply with a silent tool call.
- After a tool call, keep the prose short: one or two sentences per day on the flow, plus your open question if any. The plan, times, and rationale render on the user's map.
- If the tool result returns warnings, fix the plan in the same turn.`;

function volatileContext(ctx: PlannerContext): string {
  const parts = [
    `Current itinerary: ${
      ctx.itinerary ? JSON.stringify(ctx.itinerary) : "none yet"
    }`,
    ctx.mustSeeSpotIds?.length
      ? `USER-STARRED MUST-SEES (non-negotiable, include every one): ${ctx.mustSeeSpotIds.join(", ")}`
      : "Must-sees: none starred yet.",
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

  const history = await convertToModelMessages(messages);
  // Second cache breakpoint on the end of the conversation: next turn's
  // prefix is identical up to here, so replayed history bills at cache-read
  // rates (~0.1x) within the session instead of full price every turn.
  const lastTurn = history[history.length - 1];
  if (lastTurn) {
    lastTurn.providerOptions = {
      ...lastTurn.providerOptions,
      anthropic: { cacheControl: { type: "ephemeral" } },
    };
  }

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
    ...history,
  ];

  const result = streamText({
    model: anthropic(MODEL),
    messages: modelMessages,
    allowSystemInMessages: true,
    // Sonnet thinks before answering; the default display is "omitted"
    // (thinking blocks stream with empty text). Ask for readable summaries so
    // the panel can show what the agent is working through.
    providerOptions: {
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    },
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
