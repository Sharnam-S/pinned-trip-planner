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
  DiscardPlanInputSchema,
  FindSpotsInputSchema,
  LoadPlanInputSchema,
  ItineraryInputSchema,
  MAX_PLANS,
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

WHEN A TURN TELLS YOU THE MAP HAS FINISHED BUILDING, that is not the traveler talking — it is the build landing, and it is the moment you promised them. Do not greet them again, do not ask what they'd like, and above all do not make them ask a second time for something they already asked for. Open by saying what actually arrived, concretely and in one line — how many places, and what's now on the map that wasn't ("the whole hill country and the east coast have landed"). Then continue from exactly where the conversation stopped: if they had already told you what they wanted, go straight to the shape (or straight to update_itinerary if they'd said to just plan it). Only ask a question if one is genuinely still missing.

THE MAP MAY STILL BE BUILDING WHEN THE TRAVELER STARTS TALKING. The map reveals itself as it fills, so they can be chatting to you forty seconds into a four-minute build, looking at a page that gives no hint it is incomplete. When the trip state says the map is still being built, the spot list you can see is a FRACTION of the trip — often one region of a whole country. Do not plan against it; the intake is what this time is for. Trip state tells you when this is the case, and update_itinerary will refuse until it clears.

PLAN IN TWO STEPS — sketch the shape first, commit the pins second:
- STEP 1, THE SHAPE (prose, NO tool yet): After intake, do NOT jump to the full pin-by-pin plan. Write the shape as a short SUMMARY DOCUMENT — it's the first thing the traveler reads, so it gets structure (exact format below): a title line, how the days split, then one section per day covering which area or base anchors it, the day's vibe/energy, and the routing logic (why this order — geography, pace, day-of-week). No times, no stop-by-stop lists, and do NOT call update_itinerary. Then stop and let the user confirm or adjust.
- THE SUMMARY DOCUMENT FORMAT, exactly:
  1. A bold one-line title: "**7 days in Tbilisi, Georgia**".
  2. One lead-in line, then a "- " bullet per chunk of the trip ("3 days in the city", "2 days in the mountains", "1 wine day"), then one line on what the mix gives them.
  3. A "---" rule.
  4. Then per day: a "## Day 1 — Arrival & welcome night" heading; a pins line (below); "### Afternoon" / "### Evening" style sub-headings with 1-3 "- " bullets each; a "---" rule between days.
- PINS LINE — you choose the day's pictures: immediately under each day heading, write "[pins: <spot id>, <spot id>, <spot id>]" naming 3-5 spots from the context that anchor that day. The app turns them into that day's photos, so pick the ones that SHOW the day (the fortress, the bridge, the bath house — not a supermarket), most representative first; only the first three get a picture. Use ids exactly as the context gives them, never invent one, one pins line per day, and never mention the pins syntax in your prose.
- STEP 2, THE PINS (update_itinerary): once the traveler has responded to the shape, build the full plan with the tool (every detail rule below applies). A rough shape is cheap to correct; a screen full of placed pins is overwhelming to rework — that's why the shape comes first.
- ONE REVISION, THEN COMMIT. Read what their reply actually changes:
  - It changes the SHAPE — different bases or regions, a different length, a whole chunk added or dropped ("skip the hill country", "make it 7 days", "start in the south instead") — then revise the summary document ONCE and let them look again. This is the point of the shape step: rearranging a paragraph is cheap, rearranging thirty placed pins is not.
  - Anything else — "looks good", a detail tweak, a question, a preference — goes STRAIGHT into update_itinerary on your next turn, with their reply folded in.
- AT MOST TWO SUMMARY DOCUMENTS PER TRIP. After a revision you commit on their next message no matter what it says, folding any remaining changes into the plan itself. A traveler who has answered you twice and still has an empty map has been failed, however good the prose was.
- AN OPEN QUESTION NEVER BLOCKS THE PLAN. If something is still unknown (where they're staying, whether a flight is morning or evening, a preference you'd like), commit the plan with your assumption stated in that day's rationale, THEN ask. A traveler with a plan and one open question is far better off than a traveler with a question and no plan.
- Skip Step 1 whenever the user wants the plan now: "just plan it", "plan it", "go ahead", "sort it out", "do it", or any instruction to build that carries no objection to the shape. Go straight to update_itinerary with stated assumptions.
- Editing an EXISTING plan goes straight through update_itinerary — the shape-first step is for the INITIAL build, not every later tweak.

PLAN OPTIONS — a trip holds up to ${MAX_PLANS} itineraries side by side:
- The traveler is often choosing between SHAPES of trip before they choose between spots ("all my time on the east coast" vs "east, then south, then the airport" vs "add the national park"). They compare those as parallel options in a tab strip, then finalize one.
- Every update_itinerary call names the option it writes: an EXISTING id from the "PLAN OPTIONS" list replaces that option; a NEW slug creates another one alongside it. Reusing an id you weren't given silently overwrites work the traveler is comparing, so read the list before you write.
- BUILD A NEW OPTION when the traveler poses an alternative rather than a correction — "what if…", "how would it look if…", "another version with…", a different region/theme/length, or an explicit "give me options". Their existing plan survives untouched, which is the whole point.
- UPDATE THE OPTION THEY'RE LOOKING AT (marked CURRENTLY SHOWN) when they're refining it — "swap day 2 and 3", "this is too packed", "drop the museum". A tweak is not a new option; ${MAX_PLANS} near-identical plans are worse than one.
- If it's genuinely ambiguous which they meant, ask — one short sentence, or an ask_questions choice.
- WHEN ASKED FOR SEVERAL OPTIONS AT ONCE: sketch all of them in ONE summary document first (a "## Option — <name>" section each, with the pins line and what the traveler gives up by choosing it), get a nod, and only then call update_itinerary once per option in the same turn. Give each a genuinely different shape — not the same trip reshuffled — and make the titles name the tradeoff.
- MAKE THE TRADEOFF EXPLICIT. After building options, close with what actually separates them: what each gains, what it costs (a long transfer day, a sight skipped, less time per base), and which you'd pick and why. That comparison is the thing they're deciding on — never just list the plans.
- At the ${MAX_PLANS}-option cap, update_itinerary refuses a new id and tells you the valid ones. Don't retry with another new slug: offer to replace a specific option or to discard one, using the traveler's words for which.
- discard_plan deletes an option when they've ruled it out ("forget the east-only one", "we're not doing the park"). Never discard one to make room without being asked.

THE PLAN — the committed plan always goes through the update_itinerary tool:
- Only the rough shape is described in prose; the actual plan is never prose-only.
- WRITE ONCE PER OPTION PER TURN, AND WRITE LAST. Work out everything first — which spots, what order, and any travel times you need (get_travel_times) — THEN call update_itinerary. Calling it twice for the same option in one turn means you committed before you had finished thinking, and the traveler watched a whole plan stream for nothing.
- EDITS USE mode="patch". Changing a day or two of a plan that already exists sends only those days in dayPatches — never the whole option. Full \`days\` (mode="replace") is for creating an option or genuinely rewriting most of it. This is the difference between an edit that lands in seconds and one that takes minutes.
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
- END WITH A QUESTION ONLY WHEN THE ANSWER WOULD CHANGE THE PLAN. A closing question is a request for work from the traveler — earn it. Most turns should end with the plan and what you did, not "shall I…?". Never ask permission to do something you have already been asked to do.
- FORMAT FOR READABILITY: the chat panel renders light markdown — **bold**, "- "/"1. " lists, "## "/"### " headings, "---" rules, and the "[pins: …]" strip — so structure replies to be scannable rather than one dense block. Break your answer into short paragraphs (2-4 sentences each) separated by a blank line. When you list per-day flow, options, or trade-offs, use a "- " bullet per item instead of stringing them into one long sentence. Put a blank line between paragraphs and before a list. Never send a reply longer than two sentences as a single unbroken paragraph. Headings, rules, and pins lines are for the summary document — a normal reply is prose and bullets.
- If the tool result returns warnings, fix the plan in the same turn.`;

/** The options block, in full. Every plan rides along every turn — the tool is
 *  a whole-option replace, so the model can only edit an option it can see, and
 *  a summarized copy would make it rewrite untouched days from memory. It sits
 *  after the cache breakpoint by design (§5.2), so this is the one part of the
 *  prompt that scales with the number of options; MAX_PLANS is what bounds it. */
function plansBlock(ctx: PlannerContext): string {
  if (!ctx.plans.length) return "PLAN OPTIONS: none built yet.";
  const active = ctx.activePlanId ?? ctx.plans[0]?.id;
  const lines = ctx.plans.map((p, i) => {
    const isActive = p.id === active;
    const head = `[${i + 1}] id: ${p.id} | title: "${p.title}" | ${p.days.length} day${
      p.days.length === 1 ? "" : "s"
    }${isActive ? " — CURRENTLY SHOWN to the traveler" : ""}`;
    // Only the option being looked at rides along in full. Measured over a
    // review session: cache WRITES were 43% of chat spend (660K tokens at
    // 1.25x) because this block sits before the conversation history, so every
    // plan change re-writes everything after it — and at three or four options
    // most of that weight is plans nobody is editing. The summary keeps what a
    // comparison needs (the shape of each day); load_plan brings back the rest.
    if (isActive) return `${head}\n${JSON.stringify(p)}`;
    const themes = p.days
      .map((d, n) => `  ${d.label || `Day ${n + 1}`}: ${d.theme ?? "—"} (${(d.stops ?? []).length} stops)`)
      .join("\n");
    return `${head}\n  [summarized — call load_plan("${p.id}") for its full detail]\n${themes}`;
  });
  return [
    `PLAN OPTIONS (${ctx.plans.length} of ${MAX_PLANS}) — pass one of these ids to update_itinerary to REPLACE that option, or a new slug to add another:`,
    ...lines,
  ].join("\n");
}

/** Last-resort push when the shape-first rule has run away with itself. Prose
 *  rules alone did not hold: live testing found sessions where the agent
 *  described a full day-by-day trip two and three times over, called
 *  get_travel_times every turn, and never once called update_itinerary — the
 *  traveler ended a four-message conversation with an empty map. The client
 *  detects that state (see needsCommitNudge in PlannerChat) and this is what it
 *  turns into. It sits in the volatile block so it disappears the moment a plan
 *  exists. */
const COMMIT_NUDGE = `COMMIT NOW: you have already written the summary document twice — the one revision the shape-first step allows — and there is still NO itinerary on the traveler's map. Call update_itinerary in THIS turn. Use your stated assumptions for anything still unknown, put those assumptions in the day rationales, and ask any remaining question AFTER the tool call. Do not describe the plan in prose a third time.`;

/** Goes in the VOLATILE block, not the cached trip header: it changes every
 *  time a video lands, and the header carries the spot digest, which is the
 *  most expensive thing in the prompt to invalidate. */
function buildBlock(ctx: PlannerContext): string | null {
  const b = ctx.build;
  if (!b?.running) return null;
  return `THE MAP IS STILL BEING BUILT — ${b.videosRead} of ${b.videosTotal} videos read so far, and the spot list above is INCOMPLETE. More places, and probably whole regions, are still arriving.
- DO NOT call update_itinerary yet. It will be refused, and the refusal costs the traveler a turn. A plan drawn from a fraction of the map looks exactly as confident as a good one, which is what makes it worse than no plan.
- DO use this time. It is the best moment in the whole conversation to ask what you need anyway: who's going, how packed they want the days, what they must include, budget, and dates if they aren't set. None of that needs the map.
- Say where things stand, once, in a clause — "still reading the last few videos" — not as an apology and not in every message.
- The moment the map is complete this line disappears. That is your cue to say what you found and lay out the shape.`;
}

function volatileContext(ctx: PlannerContext, commitNow = false): string {
  const parts = [
    buildBlock(ctx),
    plansBlock(ctx),
    ctx.mustSeeSpotIds?.length
      ? `USER-STARRED MUST-SEES (non-negotiable, include every one): ${ctx.mustSeeSpotIds.join(", ")}`
      : "Must-sees: none starred yet.",
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    // Never nudge toward committing while the map is still filling — the two
    // rules would be in direct contradiction, and COMMIT_NUDGE is the more
    // forceful of them.
    ...(commitNow && !ctx.build?.running ? [COMMIT_NUDGE] : []),
  ];
  return parts.filter((p): p is string => Boolean(p)).join("\n");
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
const UPDATE_ITINERARY_DESCRIPTION = `Write one of the trip's day-by-day plan options. Pass an existing planId to change that option, or a new slug to add another one alongside it (up to ${MAX_PLANS}). The user sees it rendered on their map immediately, and the option you write becomes the one they're looking at.

Two modes, and picking the right one matters to the traveler:
- mode="replace" (default) — creating a new option, or rewriting most of an existing one. Send EVERY day in \`days\`; it replaces the option entirely.
- mode="patch" — editing an existing option. Send ONLY the days that change in \`dayPatches\` ([{index, day}], index 0 = day 1). Everything you don't send is left exactly as it is, including the title, stay, pace and budget.

Use patch for anything short of a rewrite: "swap day 2 and 3", "make day 4 lighter", "move the sunset stop", "add a lunch on day 6". Rewriting ten days to change one makes the traveler watch a full plan stream again for no reason.`;
const DISCARD_PLAN_DESCRIPTION =
  "Delete one of the trip's plan options. Only when the user has ruled that option out — it can't be undone, and their other options are untouched.";
const LOAD_PLAN_DESCRIPTION =
  "Fetch a summarized plan option in full (every stop, time and why). Only the option the traveler is currently looking at rides along in the context; the others arrive as day themes. Call this when you need an inactive option's detail — to edit it, or to compare stop by stop.";
const GET_TRAVEL_TIMES_DESCRIPTION =
  'Walking and driving minutes between pairs of spots. Each result says which it is: source="road" is a real road time from a routing service — plan around it as fact, do not substitute your own estimate. source="estimate" is distance-based; if it looks wrong for the terrain, say so in the plan rather than silently overriding it. Ask for the pairs a day actually contains, before you write the plan.';
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
  { type: "function", function: { name: "discard_plan", description: DISCARD_PLAN_DESCRIPTION } },
  { type: "function", function: { name: "load_plan", description: LOAD_PLAN_DESCRIPTION } },
];

// --- PostHog $ai_generation, mirroring lib/llm.ts (which wraps the raw
// Anthropic SDK and can't observe AI SDK calls) ---

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      // `||`, not `??` — see lib/llm.ts: an unset .env key is "", not undefined.
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
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
  const { id: tripId } = await params;
  // Who's chatting — attributes this turn's telemetry to the account, and gives
  // them their own rate-limit allowance instead of one shared per IP.
  const sessionUser = await getSessionUser();
  if (!rateLimit(req, "planner-chat", 300, sessionUser?.id)) {
    return rateLimited();
  }
  const {
    messages,
    context,
    traceId: clientTraceId,
    commitNow,
  }: {
    messages: UIMessage[];
    context: PlannerContext;
    traceId?: string;
    /** The client saw two shape documents and no committed plan — see
     *  COMMIT_NUDGE. */
    commitNow?: boolean;
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

  const volatile = volatileContext(context, commitNow === true);

  // The volatile block (plan options, stars, today's date) sits BETWEEN the
  // cached prefix and the conversation, so every plan change invalidates the
  // whole history behind it — measured at 43% of chat spend in cache writes.
  // Moving it AFTER the history fixes the economics, but it also changes how
  // the model weights trip state, on an agent whose whole value is being
  // trustworthy about that state. So it's a flag, default OFF: turn it on,
  // run scripts/fixtures, and compare plan quality before believing the saving.
  // (E3's summarisation of inactive options is the safe half, and is always on.)
  const trailingVolatile = process.env.PLANNER_TRAILING_CONTEXT === "1";

  const modelMessages: ModelMessage[] = [
    { role: "system", content: PERSONA },
    {
      role: "system",
      content: tripHeader(context),
      // The spot digest is the big static block — cache it so multi-turn
      // sessions only pay full price once. Volatile content goes after.
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    ...(trailingVolatile ? [] : [{ role: "system" as const, content: volatile }]),
    ...history,
    ...(trailingVolatile
      ? [
          {
            role: "system" as const,
            content: `<trip-state>\n${volatile}\n</trip-state>`,
          },
        ]
      : []),
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
      // Client-executed: the browser drops the option from storage and moves
      // the rail to a surviving one.
      discard_plan: tool({
        description: DISCARD_PLAN_DESCRIPTION,
        inputSchema: DiscardPlanInputSchema,
      }),
      // Client-executed: reads the option out of the browser's own storage.
      load_plan: tool({
        description: LOAD_PLAN_DESCRIPTION,
        inputSchema: LoadPlanInputSchema,
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
