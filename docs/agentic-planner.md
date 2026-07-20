# Agentic Trip Planner — Living Doc

**Read this first if you're an agent (or human) working on the planner.**
It holds the architecture, the decision log with rationale, and — most
importantly — the learnings from 9+ rounds of live-testing iteration.
Update it when you change behavior or learn something that cost time.

Status: **shipped, iterating on live feedback** · Owner: Sharnam ·
Last updated: 2026-07-19 (PRs #23–#32)

---

## 1. What this is

The trip page's second half. Part one (pre-existing): YouTube research →
spots on a map. Part two (the planner): a chat agent that behaves like a
local guide, interviews the user briefly, and builds a **day-by-day
itinerary** rendered on the map as a whiteboard — day chips, numbered
per-day markers, route lines, per-day "brief" panels, and per-stop
rationale on the spot cards.

```
┌──────────────┬────────────────────────────┬────────────────────┐
│ Trip head    │  Map, center stage         │ Tabs: Pins │ Trip  │
│ (name, meta, │  · day chips → day brief   │ overview.  Pins =  │
│ videos ▾)    │  · numbered day pins       │ detail card / 2-col│
│──────────────│  · route polylines         │ viewport grid.     │
│ Planner chat │  · mini photo popup on     │ Overview = numbered│
│ (open by     │    pin click               │ timeline of expand-│
│ default)     │  (category filters live    │ able day cards     │
│              │   in the top bar)          │ (+ empty state)    │
└──────────────┴────────────────────────────┴────────────────────┘
```
(Redesigned 2026-07-19 to a Rentizy-style map-center layout — selection
opens the right rail, not a map overlay; the map keeps a small photo
popup. Visual system: white cards floating on a soft gray canvas
(#edeff2), monochrome ink accents — day colors only on the map where
they encode routes — borderless soft-gray pill chips, white Day badges,
grayscale CARTO Positron tiles, Poppins. The chat has no close button:
one trip, one always-open conversation. The map's day-brief opens only
from the map's own chips; the overview's expanded cards are the
right-rail equivalent.)

**Core principle: the itinerary is a data object, not chat prose.** The
agent edits it via one tool (`update_itinerary`, full replace); the map,
day briefs, and spot cards all render that same object. The chat is a
means; the artifact is the product.

## 2. Architecture (and the one fact that shapes everything)

**User trips live ONLY in browser localStorage.** The server never stores
user data (deployed Vercel copies are read-only, `lib/store.ts
isReadOnly`). Everything follows from this:

- **The chat route is stateless.** The client sends trip context (spot
  digest + current itinerary + must-sees) with every request.
- **Both tools execute client-side** (no `execute` on the server):
  `update_itinerary` validates + writes localStorage; `get_travel_times`
  computes haversine from spot coords the browser already has. The map
  re-renders the moment a tool call lands mid-stream — the "whiteboard"
  effect is free.
- **All planner state is per-browser localStorage**, one key family:
  - `pinned.trip.<id>` — the trip itself (pre-existing)
  - `pinned.itin.<id>` — itinerary overlay for *sample/shared* trips
    (local trips carry `trip.itinerary` directly)
  - `pinned.mustsee.<id>` — user-starred must-see spot ids
  - `pinned.chat.<id>` — conversation history (last 80 messages)

### Stack

- **Vercel AI SDK v7** (`ai@7`, `@ai-sdk/anthropic@4`, `@ai-sdk/react`) —
  chosen over LangChain/LangGraph (abstraction tax, no UI story) and raw
  SDK + hand-rolled SSE (the UI half is the hard 20%).
- **Model: `claude-sonnet-5`** — latest Sonnet, best in line, intro
  pricing $2/$10 per MTok through 2026-08-31 (then $3/$15).
- **Route:** `app/api/trips/[id]/chat/route.ts` — `streamText` +
  `createUIMessageStreamResponse(toUIMessageStream(...))`,
  `maxDuration = 300` (see Learnings §5.1), per-IP rate limit, PostHog
  `$ai_generation` capture in `onEnd`/`onError`.
- **Client:** `components/PlannerChat.tsx` — `useChat` +
  `DefaultChatTransport` with `prepareSendMessagesRequest` (carries
  context + windowed history), `onToolCall`/`addToolOutput`,
  `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`.

### Data model (`lib/types.ts`, zod in `lib/itinerary.ts`)

```
Trip ── itinerary?: Itinerary
          days: ItineraryDay[]      label, date?, theme*, rationale*, stops
            stops: ItineraryStop[]  spotId→Spot.id, time*, durationMin*,
                                    why*, note?, slot?
          stay?  (name, lat?, lng?, note?)   pace?  budget?  updatedAt
```

Fields marked `*` are **required in the tool input schema** but optional
in the stored types (old plans must keep rendering). This asymmetry is
deliberate — see Learnings §4.1.

## 3. The agent's behavior contract (persona, in the route)

The persona is the product spec. Current contract, in order of the
user-trust lessons that produced it:

1. **Intake before planning** — ONE compact batched message asking only
   what context doesn't answer: exact dates (weekday reasoning needs
   them), stay booked/where, budget + pace, must-sees (proactively
   flagging 2–3 iconic spots). "Just plan it" → draft with stated
   assumptions.
2. **Never invent user facts** — stay is only set when told, or as a
   labeled recommendation with rationale.
3. **Every plan change goes through `update_itinerary`** (full replace,
   never prose-only), preceded by one short sentence so the stream shows
   progress before a long tool call.
4. **Times required** (arrival + duration per stop, accounting for
   travel/meals/opening hours); **rationale required** per day; **why
   required** per stop answering: worth it why / this day why / this
   time why.
5. **Day-of-week awareness** — clubs Fri/Sat, weekend-crowded spots on
   weekday mornings, closure days, trip-level arcs (beach first, party
   Saturday).
5b. **Time-of-day fit** — slot each spot at the hour its nature is best
   (sunset beach at golden hour, swimming beach mid-morning, shaded/cave
   beach at hot midday, viewpoints pre-crowd), anchor the time-sensitive
   ones first and route the flexible spots around them, and when a
   deciding fact (shade? which way does it face? swimmable?) isn't in the
   spot data, state the assumption and invite correction rather than
   ordering silently on a guess.
6. **Creator consensus weights picks** — 2+ mention spots get priority;
   dropping one requires an explicit stated reason.
7. **Meal logic** — one food spot per meal slot; consecutive food stops
   only as a stated complement pairing (dessert/coffee/shake).
8. **Starred must-sees are non-negotiable.**
9. **Truncation-aware** — durable prefs must be folded into the plan
   immediately (the context block, not old chat turns, is the source of
   truth).

## 4. Learnings — agent behavior

### 4.1 Schemas are guarantees; prose is steering (the biggest lesson)
Prose-level "times are required" produced plans with no times. Optional
zod fields get skipped; loose `describe()` strings get lazy content
("theme" = spot names joined with "+", "why" = a practical tip). The fix
that actually worked, twice: **make the field required in the tool input
schema and write the description as a content spec** (e.g. why must
answer three named questions; theme must be experiential, "never join
spot names with +"). Keep stored types optional for backward compat.

### 4.2 Judgment gaps close with one explicit rule
Sonnet follows short, explicit, targeted rules reliably. Real examples:
back-to-back restaurants (fixed by MEAL LOGIC rule naming the exact
anti-pattern), skipped 3-creator spot (CONSENSUS rule), invented stay
(NEVER-INVENT rule), beaches ordered by proximity with no regard for
sunset/swimming/shade (TIME-OF-DAY FIT rule — it now anchors
time-sensitive spots first and, when the deciding fact isn't in the spot
data, states its assumption instead of guessing silently). When live
testing surfaces a bad judgment call, prefer one added persona line
naming the anti-pattern over re-architecting.

### 4.3 Trust is rationale at every zoom level
The user's core demand ("trips are how people spend their most precious
money"). Rationale renders where decisions are inspected: trip flow in
chat prose, day structure in the map's day brief, individual picks on the
spot card ("In your plan — Day 4 (Friday) · 19:00"). The persona is told
these render on the map/cards — write for the user, not a log.

### 4.4 Intake-first beats propose-first (for this domain)
v1's "propose, don't interrogate" was wrong for high-stakes planning —
the user explicitly wanted to be asked (dates, stay, budget, must-sees)
before a draft. Compromise that works: ask everything in ONE batched
message, never re-ask what context answers, honor "just plan it".

### 4.5 Silence looks like a hang
Sonnet thinks before answering and thinking is invisible by default
(API `display` defaults to `omitted` — empty thinking blocks). Three
layers fixed it: request `thinking: {type:"adaptive", display:
"summarized"}` via providerOptions and render reasoning parts (live
italic block → collapsible); persona rule "one sentence before every
tool call"; staged status cues + elapsed counter in the UI. Note:
thinking is billed identically whether displayed or not.

## 5. Learnings — infrastructure & cost

### 5.1 The 60s Vercel timeout (the production hang)
First live session: silent dots → dead stream. Vercel runtime logs showed
`Task timed out after 60 seconds` — my own `maxDuration = 60` while the
model was mid-think on a 5-day plan. Fixes: `maxDuration = 300` (needs
Fluid Compute — default on this project), the speak-before-tool-call
rule, and error surfacing (unmask via `toUIMessageStream({onError})`,
retry buttons, detection of empty assistant turns = dropped stream).
**Debugging lesson: check Vercel runtime logs first** (`get_runtime_logs`
MCP tool) — the answer was one grep away.

### 5.2 Prompt caching layout (Anthropic caching is explicit, prefix-based)
The AI SDK does NOT auto-cache for Anthropic (OpenAI auto-caches; that's
where "plumbing handles it" intuition comes from). We place two
`cacheControl: {type:"ephemeral"}` breakpoints via providerOptions:
1. On the **spot-digest system message** — prefix semantics mean this
   also covers tool schemas + the persona before it. The volatile block
   (current itinerary, stars, today's date) sits AFTER it on purpose.
2. On the **last conversation message** — replayed history bills at
   ~0.1× within a session.
Known tradeoff: a plan-changing turn mutates the volatile block →
one-turn cache miss on history (bounded by the send window). Micro-opt
if ever justified by PostHog data: move itinerary state out of the
system tail.

### 5.3 Long-conversation cost: state-carrying truncation, not summarization
Requests send only the last 30 messages (window always opens on a user
turn so tool pairs don't strand). Safe because **the itinerary IS the
compressed conversation** — durable state (plan + whys + stars + budget
+ pace + dates) rides in the context block every turn. The persona knows
truncation happens and folds lasting chat-stated prefs into the plan
immediately. LLM summarization was rejected: extra calls, lossy, and
unnecessary at this scale. Storage keeps 80 messages for display; only
the request is windowed.

### 5.4 Chat persistence pitfalls
- Save **continuously** (debounced 400ms) + **flush on unmount** —
  saving only on settled turns lost conversations closed mid-stream.
- **Sanitize on load**: a refresh mid-turn persists an assistant message
  with a dangling tool call (no output) — replaying that is an invalid
  Anthropic conversation. Drop trailing dangling messages.
- One trip = one conversation. No "new chat" — planning context is never
  intentionally discarded.

### 5.5 Verify costs in PostHog, decide with data
Every planner turn emits `$ai_generation` (span `planner-chat`, tagged
tripId/tripName) with token + cache fields. Before optimizing anything
cost-related (model splits, summarization, Routes API), check
`llm-total-costs` there first. From turn 2 of a session,
cache_read should dominate input tokens — if not, a silent cache
invalidator crept in.

### 5.6 Anthropic platform facts that shaped decisions
- Subscription/OAuth reuse in third-party apps is **banned & enforced**
  (2026-01/02) — API key (later BYOK) is the only compliant path.
- `claude-sonnet-5` is the right model tier here; deeper thinking is a
  feature for this use case, `effort` is the knob if cost ever bites.

## 6. Learnings — Vercel AI SDK v7 specifics

- **Trust the bundled docs, not training memory** — v7 was newer than
  the building agent's knowledge. Canonical references live in
  `node_modules/ai/docs/` and provider types in
  `node_modules/@ai-sdk/anthropic/dist/index.d.ts`. Same rule as this
  repo's AGENTS.md gives for Next.js.
- Server: `streamText` → `createUIMessageStreamResponse({stream:
  toUIMessageStream({stream: result.stream, onError})})`. Use `onEnd`
  (not deprecated `onFinish`); usage details at
  `usage.inputTokenDetails.cacheReadTokens/cacheWriteTokens`.
- Multiple system messages in `messages` require
  `allowSystemInMessages: true`.
- Client-executed tools = define with `inputSchema` but **no `execute`**;
  handle in `useChat onToolCall` + `addToolOutput` (don't await it);
  auto-continue via `sendAutomaticallyWhen:
  lastAssistantMessageIsCompleteWithToolCalls`.
- Tool parts render as `part.type === "tool-<name>"` with states
  `input-streaming → input-available → output-available | output-error`;
  reasoning as `part.type === "reasoning"` with `state:
  "streaming"|"done"`.
- `useChat({messages})` seeds initial history (persistence).
  `regenerate()` retries the last turn.
- `prepareStep`/`pruneMessages` compaction is **intra-run** (multi-step
  tool loops), NOT cross-turn chat history — chat windowing is app-level
  by design.
- JSX gotcha that hit production: whitespace around `{expr}` at line
  boundaries collapses ("63spots") — use template literals for
  interpolated sentences.

## 7. File map

| File | Role |
|---|---|
| `app/api/trips/[id]/chat/route.ts` | Chat route: persona, context assembly, caching breakpoints, tool schemas (no execute), PostHog capture |
| `lib/itinerary.ts` | Zod schemas (tool input), validation/normalization, localStorage helpers (itinerary overlay, must-sees), haversine + travel estimates, spot digest builder, day colors, `PlannerContext` |
| `components/PlannerChat.tsx` | Chat UI: useChat wiring, client tool execution, history persistence (save/sanitize/window), reasoning + tool part rendering, must-see bar, auto-growing input, first-trip nudge (visitors with no own trips see fanned spot photos + a create-trip CTA → `/?start=1` instead of the planning intro) |
| `components/TripView.tsx` | Page shell: 3-panel layout, itinerary/must-see state, day chips, `DayBrief` (timeline + rationale), `SpotCard` ("In your plan" + star) |
| `components/TripMap.tsx` | Leaflet map: pill markers (star badges), plan overlay (numbered day pins, polylines, stay pin), day-fit behavior |
| `lib/types.ts` | `Itinerary`/`ItineraryDay`/`ItineraryStop` on `Trip` (stored shapes — optional fields for back-compat) |
| `app/globals.css` | Everything under `/* Planner agent */` (~end of file) |

## 8. Working on this project

- **Verify:** `npx tsc --noEmit` and `npm run build` must be clean.
  `npm run lint` carries ~20 **pre-existing** errors in untouched files
  (anchor tags, ref patterns) — the bar is "no NEW errors", checked by
  linting only the files you changed.
- **No API key in Conductor workspaces** — live model behavior is tested
  by the owner on the Vercel deployment (screenshots come back as
  feedback). You can verify to the API boundary with a dummy key
  (expect a clean SSE error stream, not a crash).
- **Workflow:** each feedback round = branch → commit → PR to `main` →
  owner merges & tests on prod. Small, complete rounds beat big batches.
- **Prompt changes are product changes** — update §3 here when you touch
  the persona.

## 9. Deliberate non-goals / deferred

- **Google Routes API travel times** (v2) — haversine × city-speed is
  deliberately "good enough to structure a day"; upgrade lazily
  (adjacent pairs only, 10K free elements/mo) when estimates prove off.
- **BYOK** (v3) — friends bring their own Anthropic key via header →
  `createAnthropic({apiKey})`; localStorage-only, never stored server-side.
- **Proposal/accept diffs, drag-to-reorder + locks, opening hours from
  Places, cross-device sync (needs accounts), stay-area recommendation
  mode with candidate pins.**
- **Rejected:** LangChain/LangGraph (see §2), LLM summarization of chat
  (§5.3), Vercel AI Gateway (fragmenting billing/analytics), Claude
  subscription harnessing (ToS, §5.6).
