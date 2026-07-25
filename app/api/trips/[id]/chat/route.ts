/**
 * Planner agent chat — stateless by design. User trips live only in the
 * browser (localStorage), so the client sends the trip context (spot digest +
 * current itinerary) with every request and executes both tools itself
 * (update_itinerary writes localStorage; get_travel_times has the coords).
 * This route just runs the model and streams back text + tool calls.
 */
import { NextRequest, after } from "next/server";
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
  AskQuestionsInputSchema,
  FindSpotsInputSchema,
  ItineraryInputSchema,
  TravelTimesInputSchema,
  spotDigest,
  type PlannerContext,
} from "@/lib/itinerary";
import { rateLimit, rateLimited } from "@/lib/ratelimit";
import { getSessionUser, type SessionUser } from "@/lib/auth";

export const runtime = "nodejs";
// Sonnet thinks before it answers, and a multi-day plan is a long think plus
// a large tool-call JSON — 60s got killed mid-stream in production (Vercel
// runtime timeout). Fluid compute allows up to 300s.
export const maxDuration = 300;

const MODEL = "claude-sonnet-5";

const PERSONA = `You are a seasoned local guide helping a traveler turn their saved spots into a day-by-day itinerary. The spots come from YouTube travel videos they researched; each has an id, category, creator mentions, and nearest-neighbor distances. Trips are how people spend their most precious money and days off — your job is to be RELIABLE and to show your reasoning, not just to be fast.

INTAKE — gather what you need with the ask_questions tool, never a wall of prose:
- The user often arrives having already answered the basics (who's going, pace, budget, dates) — a quick intake form runs before you're called. If the context and their message already cover the essentials, DON'T ask again — go straight to THE SHAPE.
- When something you genuinely need is still missing (or you need a specific choice mid-planning — e.g. which area for a free day, stay booked or not), call ask_questions with a few quick multiple-choice questions. It renders as a fast tap-through form and the answers come back to you. Use it whenever the user is choosing between options; a single open-ended clarification can be one short prose sentence.
- Things worth asking when unknown: exact travel dates (weekday closures, weekend crowds), where they're staying (or offer to recommend an area once you've seen how spots cluster), budget + pace, and must-sees (proactively surface 2-3 obviously iconic spots they'd regret skipping).
- Never re-ask what the trip context or starred must-sees already answer. If the user says "just plan it", go straight to a draft with stated assumptions.

NEVER invent facts about the user:
- Do not set the stay field unless the user told you where they're staying OR asked you to recommend — and a recommendation must come with rationale (which spots it's near, transit, vibe) and be clearly labeled as your suggestion they can change.
- State assumptions out loud whenever you plan around one.

PLAN IN TWO STEPS — sketch the shape first, commit the pins second:
- STEP 1, THE SHAPE (prose, NO tool yet): After intake, do NOT jump to the full pin-by-pin plan. Write the shape as a short SUMMARY DOCUMENT — it's the first thing the traveler reads, so it gets structure (exact format below): a title line, how the days split, then one section per day covering which area or base anchors it, the day's vibe/energy, and the routing logic (why this order — geography, pace, day-of-week). No times, no stop-by-stop lists, and do NOT call update_itinerary. Then stop and let the user confirm or adjust.
- THE SUMMARY DOCUMENT FORMAT, exactly:
  1. A bold one-line title: "**7 days in Tbilisi, Georgia**".
  2. One lead-in line, then a "- " bullet per chunk of the trip ("3 days in the city", "2 days in the mountains", "1 wine day"), then one line on what the mix gives them.
  3. A "---" rule.
  4. Then per day: a "## Day 1 — Arrival & welcome night" heading; a pins line (below); "### Afternoon" / "### Evening" style sub-headings with 1-3 "- " bullets each; a "---" rule between days.
- PINS LINE — you choose the day's pictures: immediately under each day heading, write "[pins: <spot id>, <spot id>, <spot id>]" naming 3-5 spots from the context that anchor that day. The app turns them into that day's photos, so pick the ones that SHOW the day (the fortress, the bridge, the bath house — not a supermarket), most representative first; only the first three get a picture. Use ids exactly as the context gives them, never invent one, one pins line per day, and never mention the pins syntax in your prose.
- STEP 2, THE PINS (update_itinerary): only once the user is happy with the shape, build the full plan with the tool (every detail rule below applies). A rough shape is cheap to correct; a screen full of placed pins is overwhelming to rework — that's why the shape comes first.
- Skip Step 1 only when the user says "just plan it" (or clearly wants the whole plan now): go straight to update_itinerary with stated assumptions.
- Editing an EXISTING plan goes straight through update_itinerary — the shape-first step is for the INITIAL build, not every later tweak.

THE PLAN — the committed plan always goes through the update_itinerary tool:
- Only the rough shape is described in prose; the actual plan is never prose-only. The tool replaces the whole plan, so always send every day, not just the changed one.
- Use spot ids exactly as given. Only plan with spots from the context; local knowledge (neighborhoods, transport, opening hours) goes in themes, notes, and rationale.
- FINDING NEW SPOTS: the context is the traveler's saved spots — you can't invent pins that aren't there. When the user asks for an area or a type of place the current spots don't cover ("more spots in Ahangama", "a spa or yoga day", "any night markets?"), and nothing on the list fits, call find_spots with the area and/or interest — it searches fresh videos and adds real pins to the map, then returns them for you to place. Say what you're doing first ("Let me pull some Ahangama spots — one sec…"), since it takes ~20-30s. Don't reach for it when existing spots already satisfy the ask, or to re-fetch something you just fetched — prefer what's on the map.
- Starred must-sees (in context) are NON-NEGOTIABLE — every one appears in the plan. If one genuinely can't fit, say so explicitly and ask what to drop instead. Never silently skip an iconic spot: if something like the destination's most famous sight sits unassigned, flag it.
- TIMES ARE REQUIRED: give every stop a realistic arrival time ("time", 24h) and duration ("durationMin"), accounting for travel between stops (use the "near:" distances or get_travel_times), meal breaks, and typical opening hours. The user must be able to see when their day starts, when they'll finish, and how long each stop gets.
- RATIONALE IS REQUIRED: fill each day's "rationale" with 1-2 sentences on why these spots are grouped and ordered this way (geography, hours, energy curve). This is shown on the map when the user inspects a day — it's how you earn trust.
- PER-STOP "why" IS REQUIRED and must answer three things in 1-2 sentences: why the spot is worth their time at all (what makes it special — use the creators' takes), why this day, and why this time of day. "Quick photo stop" is a note, not a why. It's shown on the spot's own card when the user clicks it.
- DAY THEMES ARE EXPERIENTIAL, never a list of spot names joined with "+" — the map already shows where they're going; the theme says what kind of day it is ("Harbor icons & a sunset bridge walk").
- DAY-OF-WEEK AWARENESS: work out each day's weekday from its date and let it shape the plan. Nightlife, clubs, and lively dinner scenes belong on Friday/Saturday — a club on a Wednesday is a wasted evening. Spots that draw weekend crowds (markets, viewpoints, big parks) are better on weekday mornings if the trip allows. Evening-energy places (neon squares, night markets) go on nights that are actually lively. Check weekly closure days (many museums close Mondays). Sequence across the trip too: e.g. a Wednesday-to-Monday beach trip does beach days first and saves the party night for Saturday. When you apply one of these calls, say so in that stop's "why".
- TIME-OF-DAY FIT: slot each spot at the hour its nature is best, then route the flexible spots around those anchors — a spot's "right time" outranks pure proximity. Examples: a west-facing beach or clifftop is a SUNSET stop; a swimming or snorkelling beach wants calm morning-to-midday water with sun overhead; a beach hemmed by cliffs or reached through a cave (little direct sun, cooler) suits the HOT MIDDAY; a surf break follows swell/tide; markets and viewpoints are best EARLY, before crowds and haze. Place the time-sensitive spots first as anchors, then order the flexible ones by geography around them. When two spots compete for the same prime slot (e.g. two candidate sunset beaches), keep the one whose whole appeal DEPENDS on that slot and give the other a different time or day — say why in its "why". If the deciding fact isn't in the spot's description (does this beach have afternoon shade? which way does it face? is it good for swimming?), do NOT order it silently on a guess — state the assumption you're planning on and invite the user to correct it.
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
- FORMAT FOR READABILITY: the chat panel renders light markdown — **bold**, "- "/"1. " lists, "## "/"### " headings, "---" rules, and the "[pins: …]" strip — so structure replies to be scannable rather than one dense block. Break your answer into short paragraphs (2-4 sentences each) separated by a blank line. When you list per-day flow, options, or trade-offs, use a "- " bullet per item instead of stringing them into one long sentence. Put a blank line between paragraphs and before a list. Never send a reply longer than two sentences as a single unbroken paragraph. Headings, rules, and pins lines are for the summary document — a normal reply is prose and bullets.
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
    ctx.party ? `Who's going: ${ctx.party}` : null,
    "",
    "Spots (id | name | category | mentions | description | tips | nearest neighbors):",
    spotDigest(ctx.spots),
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

// Tool descriptions — single source of truth, used both in the streamText
// `tools` map (sent to the model) and in the $ai_tools PostHog property (so
// the analytics know the full tool surface, not just tools that got called).
const UPDATE_ITINERARY_DESCRIPTION =
  "Replace the trip's day-by-day itinerary. Send the COMPLETE plan every time (all days), not a diff. The user sees it rendered on their map immediately.";
const GET_TRAVEL_TIMES_DESCRIPTION =
  "Estimate walking and driving/transit minutes between pairs of spots (straight-line based; good for day planning).";
const ASK_QUESTIONS_DESCRIPTION =
  "Ask the user a few quick multiple-choice questions to gather what you need (who's going, pace, budget, a specific preference). Renders as a fast tap-through form, one question at a time — use this instead of asking in prose whenever the user is choosing between options. Their answers come back as the tool result.";
const FIND_SPOTS_DESCRIPTION =
  "Find NEW spots the trip doesn't have yet by searching fresh YouTube travel videos for a specific area or interest, then adding the resulting pins to the map. Call ONLY when the user wants somewhere or something the current spots don't cover (a locality like 'Ahangama', a theme like 'a spa/yoga day') — not when existing spots already fit. It's slow (~20-30s) and costs quota, so say what you're doing first. The new spots (id, name, category) come back as the tool result for you to fold into the plan.";

// The available tool surface, in PostHog's $ai_tools shape. Analytics-only —
// this rides in the telemetry event, NOT in the Anthropic request (the model
// already gets the tools via streamText), so it adds nothing to model billing.
const AI_TOOLS = [
  { type: "function", function: { name: "update_itinerary", description: UPDATE_ITINERARY_DESCRIPTION } },
  { type: "function", function: { name: "get_travel_times", description: GET_TRAVEL_TIMES_DESCRIPTION } },
  { type: "function", function: { name: "ask_questions", description: ASK_QUESTIONS_DESCRIPTION } },
  { type: "function", function: { name: "find_spots", description: FIND_SPOTS_DESCRIPTION } },
];

// --- PostHog $ai_generation, mirroring lib/llm.ts (which wraps the raw
// Anthropic SDK and can't observe AI SDK calls) ---

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

// PostHog drops events over ~1MB; the prompt (persona + spot digest + history)
// can be tens of KB per message — keep the debugging value, cap the payload.
// Mirrors lib/llm.ts.
const MAX_CONTENT_CHARS = 50_000;

function truncate(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? `${text.slice(0, MAX_CONTENT_CHARS)}… [truncated ${text.length - MAX_CONTENT_CHARS} chars]`
    : text;
}

// PostHog silently DROPS any event over ~1MB. Per-message truncation isn't
// enough on its own — a long windowed history can still sum past the limit —
// so cap the serialized input total too. Well under 1MB leaves headroom for
// the output + other properties.
const MAX_INPUT_CHARS = 300_000;

/** Render one message's content as readable text, preserving the parts that
 *  explain agent decisions: prior reasoning, tool calls (with args), and tool
 *  results (e.g. travel times the agent planned around). A plain-string
 *  message passes through; structured content is labeled per part. */
function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part);
      const p = part as {
        type?: string;
        text?: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
      };
      switch (p.type) {
        case "text":
          return p.text ?? "";
        case "reasoning":
          return `[reasoning] ${p.text ?? ""}`;
        case "tool-call":
          return `[tool-call: ${p.toolName}] ${JSON.stringify(p.input)}`;
        case "tool-result":
          return `[tool-result: ${p.toolName}] ${JSON.stringify(p.output)}`;
        default:
          return `[${p.type ?? "part"}] ${JSON.stringify(part)}`;
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** Flatten the model prompt into PostHog's `$ai_input` shape — one entry per
 *  message, tagged by role (system / user / assistant / tool) so app-, user-,
 *  and model-origin content stay distinguishable. Oldest history is dropped
 *  if the payload would risk PostHog's event-size limit; the system prefix
 *  and most recent turns (the useful debugging context) are kept. */
function formatInput(messages: ModelMessage[]): { role: string; content: string }[] {
  const formatted = messages.map((m) => ({
    role: m.role,
    content: truncate(renderContent(m.content)),
  }));
  let total = formatted.reduce((n, m) => n + m.content.length, 0);
  let dropped = 0;
  while (total > MAX_INPUT_CHARS) {
    // Drop the oldest non-system message (system prefix stays; it's bounded).
    const idx = formatted.findIndex((m) => m.role !== "system");
    if (idx === -1) break;
    total -= formatted[idx].content.length;
    formatted.splice(idx, 1);
    dropped++;
  }
  if (dropped > 0) {
    const idx = formatted.findIndex((m) => m.role !== "system");
    formatted.splice(Math.max(idx, 0), 0, {
      role: "system",
      content: `[${dropped} older message(s) omitted to fit PostHog's event-size limit]`,
    });
  }
  return formatted;
}

async function captureGeneration(opts: {
  traceId: string;
  tripId: string;
  tripName: string;
  /** Signed-in account (from the session cookie) — keys the event to a PostHog
   *  person so cost/usage slice per user. Null = anonymous, keyed by trace. */
  user: SessionUser | null;
  latencySec: number;
  input: { role: string; content: string }[];
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  outputText: string;
  reasoning?: string;
  toolCalls?: { name: string; args: unknown }[];
  error?: unknown;
  /** Turn was cut off (client disconnect or the Vercel maxDuration timeout).
   *  Tokens/text are partial. */
  aborted?: boolean;
}) {
  if (!posthog) return;
  try {
    // The AI SDK reports `inputTokens` as the TOTAL prompt (cache reads +
    // writes + uncached). PostHog treats $ai_input_tokens as the uncached
    // remainder and prices the cache buckets separately, so sending the total
    // double-bills the cached prefix (~3x inflated cost). Send only the
    // genuinely-new tokens.
    const cacheRead = opts.cacheRead ?? 0;
    const cacheWrite = opts.cacheWrite ?? 0;
    const uncachedInput = Math.max(
      0,
      (opts.inputTokens ?? 0) - cacheRead - cacheWrite
    );
    posthog.capture({
      distinctId: opts.user?.id ?? opts.traceId,
      event: "$ai_generation",
      properties: {
        ...(opts.user
          ? {
              userId: opts.user.id,
              $set: {
                ...(opts.user.email ? { email: opts.user.email } : {}),
                ...(opts.user.name ? { name: opts.user.name } : {}),
              },
            }
          : { $process_person_profile: false }),
        $ai_provider: "anthropic",
        $ai_model: MODEL,
        $ai_input: opts.input,
        $ai_input_tokens: uncachedInput,
        $ai_output_tokens: opts.outputTokens ?? 0,
        ...(cacheRead ? { $ai_cache_read_input_tokens: cacheRead } : {}),
        ...(cacheWrite ? { $ai_cache_creation_input_tokens: cacheWrite } : {}),
        $ai_output_choices: [
          {
            role: "assistant",
            // Reasoning is the agent's decision process — the highest-value
            // signal for understanding/improving behavior. It's part of the
            // output, not the input, and `event.text` omits it, so fold it in
            // labeled and ahead of the final answer.
            content: truncate(
              [
                opts.reasoning ? `[reasoning]\n${opts.reasoning}` : "",
                opts.outputText,
              ]
                .filter(Boolean)
                .join("\n\n")
            ),
            // Tool-call turns (e.g. update_itinerary) carry no text, so
            // capturing only outputText logged an empty assistant message.
            // Surface the calls so those turns are readable.
            ...(opts.toolCalls?.length
              ? {
                  tool_calls: opts.toolCalls.map((c) => ({
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: truncate(JSON.stringify(c.args)),
                    },
                  })),
                }
              : {}),
          },
        ],
        $ai_latency: opts.latencySec,
        // 499 = client closed request (aborted/timed-out turn); 500 = error.
        $ai_http_status: opts.error ? 500 : opts.aborted ? 499 : 200,
        ...(opts.aborted ? { aborted: true } : {}),
        $ai_trace_id: opts.traceId,
        // Trace = one sitting; session = the whole trip's conversation across
        // sittings/reloads. One chat per trip, so tripId is the session key —
        // this lights up PostHog's Sessions tab with per-trip rollups.
        // ($ai_session_id is LLM-analytics-specific, NOT PostHog's $session_id.)
        ...(opts.tripId ? { $ai_session_id: opts.tripId } : {}),
        // The tools available to the model this turn — lets PostHog's Tools tab
        // show the full surface, including turns where nothing was called.
        $ai_tools: AI_TOOLS,
        $ai_span_name: "planner-chat",
        ...(opts.error ? { $ai_is_error: true, $ai_error: String(opts.error) } : {}),
        // Custom analytics dimension (deliberately NOT $ai_-prefixed so it
        // never touches cost): how much of the turn was thinking. Anthropic
        // fuses thinking into output_tokens and exposes no separate count, so
        // reasoning-text length is the honest proxy for a thinking-vs-answer
        // ratio when tuning the persona.
        ...(opts.reasoning ? { reasoning_chars: opts.reasoning.length } : {}),
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
  // Who's chatting — attributes this turn's telemetry to the account.
  const sessionUser = await getSessionUser();
  const {
    messages,
    context,
    traceId: clientTraceId,
  }: {
    messages: UIMessage[];
    context: PlannerContext;
    traceId?: string;
  } = await req.json();

  if (!context?.spots?.length) {
    return Response.json(
      { error: "Missing trip context." },
      { status: 400 }
    );
  }

  // The client mints one traceId per sitting (survives the tool-call
  // round-trips within a mount, resets on reload). Group across sittings by
  // the tripId property — one chat per trip.
  const traceId = clientTraceId ?? crypto.randomUUID();
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

  // Telemetry must outlive the response. A serverless function can freeze the
  // instant the stream closes, so a fire-and-forget capture in onEnd/onError
  // races function teardown and gets dropped — which is exactly how trailing
  // turns (e.g. a post-tool-call summary) went missing from PostHog. This
  // barrier is resolved by whichever lifecycle callback fires (end/error/
  // abort); `after()` below keeps the function alive until it settles.
  let settleCapture: () => void = () => {};
  const captureSettled = new Promise<void>((resolve) => {
    settleCapture = resolve;
  });

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
        description: UPDATE_ITINERARY_DESCRIPTION,
        inputSchema: ItineraryInputSchema,
      }),
      get_travel_times: tool({
        description: GET_TRAVEL_TIMES_DESCRIPTION,
        inputSchema: TravelTimesInputSchema,
      }),
      // Client-executed via the question UI: the browser renders the tap-through
      // form and returns the user's answers as the tool output.
      ask_questions: tool({
        description: ASK_QUESTIONS_DESCRIPTION,
        inputSchema: AskQuestionsInputSchema,
      }),
      // Client-executed: the browser runs a scoped YouTube discovery, adds the
      // new pins to localStorage (map re-renders), and returns the new spots.
      find_spots: tool({
        description: FIND_SPOTS_DESCRIPTION,
        inputSchema: FindSpotsInputSchema,
      }),
    },
    onEnd: (event) => {
      captureGeneration({
        traceId,
        tripId,
        tripName: context.tripName,
        user: sessionUser,
        latencySec: (Date.now() - start) / 1000,
        input: formatInput(modelMessages),
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheRead: event.usage.inputTokenDetails?.cacheReadTokens,
        cacheWrite: event.usage.inputTokenDetails?.cacheWriteTokens,
        outputText: event.text,
        reasoning: event.reasoningText,
        toolCalls: event.toolCalls?.map((c) => ({
          name: c.toolName,
          args: c.input,
        })),
      }).finally(settleCapture);
    },
    onError: ({ error }) => {
      captureGeneration({
        traceId,
        tripId,
        tripName: context.tripName,
        user: sessionUser,
        latencySec: (Date.now() - start) / 1000,
        input: formatInput(modelMessages),
        outputText: "",
        error,
      }).finally(settleCapture);
    },
    // A turn cut off by a client disconnect or the Vercel maxDuration timeout
    // (the §5.1 production hang) fires neither onEnd nor onError — without this
    // the turn vanishes from analytics. Log the partial output + best-effort
    // token totals from the finished steps, flagged aborted.
    onAbort: ({ steps }) => {
      captureGeneration({
        traceId,
        tripId,
        tripName: context.tripName,
        user: sessionUser,
        latencySec: (Date.now() - start) / 1000,
        input: formatInput(modelMessages),
        inputTokens: steps.reduce((n, s) => n + (s.usage?.inputTokens ?? 0), 0),
        outputTokens: steps.reduce((n, s) => n + (s.usage?.outputTokens ?? 0), 0),
        outputText: steps.map((s) => s.text ?? "").join(""),
        aborted: true,
      }).finally(settleCapture);
    },
  });

  // Keep the function alive past the response so the capture's PostHog flush
  // completes. `after()` runs even when the response errored or was aborted.
  after(() => captureSettled);

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
