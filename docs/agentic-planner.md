# Agentic Trip Planner — Living Doc

**Read this first if you're an agent (or human) working on the planner.**
It holds the architecture, the decision log with rationale, and — most
importantly — the learnings from 9+ rounds of live-testing iteration.
Update it when you change behavior or learn something that cost time.

Status: **shipped, iterating on live feedback** · Owner: Sharnam ·
Last updated: 2026-07-23 (accounts/multi-user — §2b)

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
│ (name, meta, │  · search box (fly-to) in  │ overview.  Pins =  │
│ videos ▾)    │    the top bar             │ detail card / 2-col│
│──────────────│  · day chips → day brief   │ viewport grid, with│
│ Planner chat │  · numbered day pins       │ category filter    │
│ (open by     │  · route polylines         │ chips above it.    │
│ default)     │  · mini photo popup on     │ Overview = numbered│
│              │    pin click               │ timeline (+ empty).│
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

(2026-07-23: the map top bar now holds a Google-Maps-style **search box**
instead of the Filters pill — typing matches spots by name/category and
picking a result flies the map there + opens the detail. Category filter
chips moved to the pins rail, right above the grid, where testers
instinctively looked for them. Search spans all spots and clears an active
category filter if it would hide the picked result. Map fly-to is a
one-shot `flyTo={lat,lng,zoom,key}` prop on `TripMap`; bumping `key`
re-fires. See `map-search` / `pins-filters` in `TripView.tsx` + globals.css.)

(2026-07-23b, follow-up feedback: (1) **search now covers the real map**,
not just our spots. `GET /api/geocode` proxies OSM Nominatim (UA set
server-side, edge-cached, viewbox-biased to the trip); the dropdown shows
two groups — "Pinned in this trip" (our YouTube spots, 📍-tagged, and they
pulse on the map as you type via `searchMatchIds` → `.pin-pill.search-match`)
and "Places on the map". Picking a place drops a transient `searchMarker`
and fits its bbox (`flyTo.bounds` → `flyToBounds`) so nearby pins come into
view. (2) The pins-rail filters were too heavy always-open, so they now
**collapse to a `pf-toggle` button** that fans open (`pins-filters.open`).
(3) Removed the category badge (`tile-cat`) from grid photos — name + photo
are self-explanatory.)

**Core principle: the itinerary is a data object, not chat prose.** The
agent edits it via one tool (`update_itinerary`, full replace); the map,
day briefs, and spot cards all render that same object. The chat is a
means; the artifact is the product.

## 2. Architecture (and the one fact that shapes everything)

**localStorage is the working copy of every trip; the browser orchestrates
everything.** (Since 2026-07-23 there are also accounts — see §2b — but they
sync *copies* of the localStorage state; nothing about the planner's
client-first design changed.) Everything follows from this:

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
  - `pinned.pushed.<id>` / `pinned.pending-trip` — account-sync change
    hashes and the through-SSO form stash (§2b)

### 2b. Accounts & multi-user (2026-07-23)

Google SSO + per-user server storage, added without disturbing the
client-first architecture above. The design:

- **Auth is hand-rolled OIDC** (`lib/auth.ts`, `app/api/auth/*`): Google
  authorization-code flow, id_token verified against Google's JWKS (jose),
  session = HS256 JWT in an **httpOnly cookie** (`pinned_session`, 30d) —
  deliberately NOT localStorage, where injected scripts could read it. No
  auth framework: two small routes, no version coupling with Next 16.
- **Storage: Postgres via `lib/db.ts`** — Neon serverless when
  `DATABASE_URL` is set; **PGlite** (in-process Postgres under `.data/`)
  in local dev, so `npm run dev` needs zero setup. Three tables:
  `users`, `trips` (id, owner_id, data jsonb), `chats` (trip_id, messages
  jsonb). Schema bootstraps with `CREATE TABLE IF NOT EXISTS` — no
  migration toolchain.
- **Three env modes** (`.env.example`): Google creds + `DATABASE_URL` +
  `AUTH_SECRET` = real SSO · local dev with none of them = instant
  "Dev User" fallback sign-in (never active in prod builds) · Vercel with
  none = auth disabled, the app behaves exactly as before accounts
  (`/api/me` → `{enabled:false}` and the client keeps the legacy flow —
  safe rollout before env vars exist).
- **Sync, not migration** (`lib/sync.ts` + `components/SyncAgent.tsx` in
  the root layout): localStorage stays the fast working copy; every local
  change debounce-pushes owned trips (PUT `/api/trips/[id]`) and chats
  (PUT `/api/trips/[id]/messages`). Local trips with no `ownerId` are
  **adopted** by the signed-in account on first sweep (pre-account trips
  migrate silently); trips owned by a *different* account on a shared
  computer are never pushed. Change detection = djb2 hash remembered in
  `pinned.pushed.<id>`.
- **Cross-device open = adoption in reverse** (`TripView`): a trip URL not
  in this browser fetches from the API; if it comes back with my
  `ownerId`, it's saved into localStorage and flips to the local pipeline
  (editing, build resume, sync all work as at home).
- **Privacy model:** DB trips are served only to their owner — anyone else
  falls through to samples/Blob and gets 404. The Blob community library
  is now **explicit opt-in** (Share button in the trip header, owner id
  stripped from the public copy); the runner's auto-publish only fires on
  no-auth deploys where it remains the only cross-device path. The
  **video cache stays global** (`lib/videoCache.ts`) — extractions are
  trip- and user-independent, so one user processing a video benefits
  everyone (and the bill is paid once).
- **Landing UX:** ONE page for everyone — the sky/clouds landing (owner
  iterated through a separate app-shell dashboard on 2026-07-24 and
  reverted the same day: "the current landing page looks much better").
  Signed out: hero + Sign in pill + community gallery; "Build my map"
  stashes the form in `pinned.pending-trip`, rides through SSO, and the
  build auto-resumes on return. Signed in: same page with a **profile
  chip** (avatar → name/email/sign-out popover) in the nav, the
  browser-frame section shows **your account trips** (light summaries
  from `GET /api/me/trips`, computed in SQL — never full trips in a
  list) instead of the community library, and the hero stat chip adds
  "≈ Nh watching saved" (~20 min per video read).
- **Chat across devices:** the chat route stays stateless; persistence
  mirrors the localStorage save — the browser PUTs the sanitized message
  array (debounced), and a fresh device seeds `useChat` from the server
  copy only when localStorage is empty (local always wins; it is what got
  synced up in the first place).

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

1. **Intake before planning — structured, not prose.** A client-rendered
   **instant intake card** (`QuestionFlow`, no model round-trip) collects the
   universals on trip-open (who/pace/must-sees/budget, + dates if unset) and
   compiles them into the first message — so the model's first act is the shape
   (§3b), not a 40s think-then-interrogate. Mid-planning, the model gathers any
   missing choice with the **`ask_questions` tool** (same tap-through card, one
   question at a time, answers returned in one shot) — never a wall of prose.
   Things to ask when unknown: dates (weekday reasoning), stay, budget + pace,
   must-sees (flag 2–3 iconic). "Just plan it" → draft with stated assumptions.
2. **Never invent user facts** — stay is only set when told, or as a
   labeled recommendation with rationale.
3. **Every plan change goes through `update_itinerary`** (full replace,
   never prose-only), preceded by one short sentence so the stream shows
   progress before a long tool call.
3b. **Shape before pins (initial build only)** — the first plan is proposed
   as a rough prose skeleton (area/base + vibe + routing logic per day, no
   spot ids or times, no tool call), then the user confirms/adjusts the shape,
   then `update_itinerary` commits the pins. Course-correcting a rough shape is
   cheap; reworking a screen of placed pins is overwhelming. "Just plan it"
   skips it; later edits go straight through the tool. The prose skeleton is
   the ONE exception to rule 3's "never prose-only" — it precedes the commit,
   it doesn't replace it.
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

**Two capture paths, one schema — and the AI-SDK path had three bugs.**
`lib/llm.ts` wraps the raw Anthropic SDK (discover/extract); the chat route
hand-rolls its own `$ai_generation` around `streamText`. They must stay in
sync. The route's copy drifted and mis-reported for a while:
- **Inflated cost (~3×).** PostHog uses **exclusive** cache counting for
  Anthropic (auto-detected from `$ai_provider: "anthropic"` when
  `$ai_cache_reporting_exclusive` is unset — see
  [calculating-costs](https://posthog.com/docs/llm-analytics/calculating-costs)):
  `$ai_input_tokens` must be the *uncached* input, and `cache_read`/
  `cache_creation` are priced as separate buckets on top. But the AI SDK's
  `usage.inputTokens` is the **total** (`= noCache + cacheRead + cacheWrite`;
  confirmed in `@ai-sdk/anthropic` `dist/index.js`, the `inputTokens.total`
  field). Sending that total made PostHog bill the cached prefix twice — once
  full, once discounted. Fix: send `inputTokens − cacheRead − cacheWrite`.
  (The raw-SDK path is immune: Anthropic's `usage.input_tokens` already
  excludes cache.) Diagnostic that nailed it: a warm turn's cost equalled
  `input×full + cacheRead×0.1 + cacheWrite×1.25 + output` to 4 sig-figs.
- **Empty Input panel.** The route never set `$ai_input`. Fixed by
  flattening `modelMessages` (mirrors `lib/llm.ts` `formatInput`).
- **Empty Output on tool turns.** Captured only `event.text`, which excludes
  tool-call and reasoning parts — so an `update_itinerary`-only turn logged a
  blank assistant message. Fixed by adding `tool_calls` to the output choice
  from `event.toolCalls` (`{toolName, input}` in v7).

**Capture built for behavior debugging (why the agent decides what it does).**
The route now records the full decision context:
- **Reasoning** — `event.reasoningText` folded into the assistant output
  choice, labeled `[reasoning]` ahead of the final text. It's the single
  highest-value signal for tuning the persona. (It lives in the *output*, not
  the input — it's what the model produced.) A `reasoning_chars` custom
  property (no `$ai_` prefix → cost-neutral) records thinking volume for a
  thinking-vs-answer ratio; Anthropic exposes no separate thinking-token
  count, so text length is the honest proxy.
  - **Do NOT emit `$ai_reasoning_tokens` for Anthropic.** PostHog issue #3160
    (fixed, PR #55480) makes PostHog *add* reasoning tokens to output cost —
    correct for providers whose `output_tokens` is text-only, but Anthropic's
    `output_tokens` **already includes thinking** (confirmed: `@ai-sdk/
    anthropic` maps `outputTokens.total = usage.output_tokens`, leaves
    `reasoning` void). Emitting it would double-count. Unlike cache (distinct
    0.1×/1.25× rates → separate buckets required), thinking is billed at the
    plain output rate, so `output_tokens × rate` already prices it exactly —
    there is no independent cost accounting to add.
- **Rich `$ai_input` by role** — `renderContent` labels each structured part:
  `[reasoning]`, `[tool-call: name] {args}`, `[tool-result: name] {output}`.
  Roles stay distinct — `system` (persona + trip header + volatile context),
  `user` (traveler's text), `assistant` (model's prior turns + tool calls),
  `tool` (results fed back, e.g. travel times). The token bulk is `system` +
  `assistant`/`tool` history, not user text.

Guard when adding `$ai_input`: PostHog **silently drops events over ~1MB**.
Per-message truncation (50K) isn't enough — a windowed history can sum past
it — so `formatInput` also caps the serialized total (`MAX_INPUT_CHARS` 300K),
dropping oldest history first (system prefix + recent turns kept, a
`[N older message(s) omitted]` breadcrumb inserted). Without this, a long
session would vanish from analytics entirely (worse than a blank field).

**Deliver the capture with `after()`, not fire-and-forget.** Symptom that
exposed this: a completed post-tool-call summary turn streamed to the user but
was **missing from its trace**. Cause: the capture ran as `void
captureGeneration(...)` in `onEnd` — the `await posthog.flush()` inside it can't
help once the *route* doesn't await it, because a serverless function can freeze
the instant the response stream closes and drop the detached flush. The
**trailing** turn is most exposed (nothing keeps the function warm after it).
Fix: a barrier promise resolved by the lifecycle callback, awaited via Next's
`after()` (`next/server`) — it keeps the function alive past the response and
runs even on error/abort. Also added an **`onAbort`** path (fires on client
disconnect or the §5.1 maxDuration timeout — neither onEnd nor onError fire):
logs partial text + best-effort step-usage tokens, flagged `aborted: true` with
`$ai_http_status: 499`, so a killed turn is visible instead of silently gone.

**Trace = one sitting, generation = one API call, group by tripId.**
`$ai_trace_id` (= the client-minted `traceId`, a `useRef` UUID in
`PlannerChat` — renamed from the misleading `chatSessionId`) groups every
generation in a **sitting** into one trace; each generation is one POST to the
route, i.e. one Anthropic call (thinking lives *inside* a generation, not as
its own). A single user turn that hits a tool spawns **two** generations — the
tool-call round and the post-tool-result round — because tools execute
client-side and `sendAutomaticallyWhen` re-sends. The UUID is minted per mount
(**not** persisted), so a reload deliberately starts a fresh trace = one trace
per sitting. To follow a conversation *across* sittings/reloads, group by the
`tripId` property (emitted on every event, stable for the trip's life) — which
matches the product model: one chat per trip. `tripId` collides only across
users of a shared *sample* trip (no accounts to separate them anyway); a
user's own local trips have unique ids. A persisted, independent
`chatSessionId` property is only worth adding if per-person separation on
shared trips ever matters (deferred).

Two properties light up PostHog's native tabs:
- **`$ai_session_id` = `tripId`** — populates the **Sessions** tab (one session
  per trip, spanning all sittings, with cost/generation/duration rollups).
  Note: `$ai_session_id` is LLM-analytics-specific and **distinct** from
  PostHog's standard `$session_id` (which we'd only have from a browser SDK).
- **`$ai_tools`** — the available tool surface (`update_itinerary`,
  `get_travel_times`), so the **Tools** tab shows tools even on turns where none
  was called. Analytics-only: it rides in the telemetry event, not the Anthropic
  request, so it adds nothing to model billing (the model already gets the tools
  via `streamText`). Descriptions are a single source of truth so the model-facing
  and analytics-facing copies can't drift. Tool *calls* themselves come from
  `$ai_output_choices[].tool_calls` (captured in the §5.5 output fix).

Reminder that shaped the reading of all this: caching does **not** make the
prefix "cost once" — each turn re-reads the whole (growing) prefix at ~0.1×,
and any plan-changing turn rewrites the post-breakpoint tail at 1.25×
(§5.2). Latency is not a cost driver; Anthropic bills tokens, not seconds.

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
| `components/PlannerChat.tsx` | Chat UI: useChat wiring, client tool execution, history persistence (save/sanitize/window), reasoning + tool part rendering, must-see bar, auto-growing input, first-trip nudge; `QuestionFlow` tap-through form powering the instant intake card and the `ask_questions` tool (renders when no itinerary yet; `ask_questions` collects answers → `addToolOutput`) |
| `components/TripView.tsx` | Page shell: 3-panel layout, itinerary/must-see state, day chips, `DayBrief` (timeline + rationale), `SpotCard` ("In your plan" + star) |
| `components/TripMap.tsx` | Leaflet map: pill markers (star badges), plan overlay (numbered day pins, polylines, stay pin), day-fit behavior |
| `lib/types.ts` | `Itinerary`/`ItineraryDay`/`ItineraryStop` on `Trip` (stored shapes — optional fields for back-compat); `Trip.ownerId` |
| `lib/auth.ts` + `app/api/auth/*` + `app/api/me*` | Google SSO, session cookie, dev-user fallback (§2b) |
| `lib/db.ts` | Postgres (Neon prod / PGlite dev): users, trips, chats + ownership-enforcing queries (§2b) |
| `lib/sync.ts` + `components/SyncAgent.tsx` | Debounced localStorage→account push, adoption of pre-account trips, chat sync (§2b) |
| `lib/useSession.ts` + `components/AccountMenu.tsx` | Client session cache (one `/api/me` per load), avatar menu |
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
  Places, stay-area recommendation mode with candidate pins.**
  (Cross-device sync shipped 2026-07-23 with accounts — §2b.)
- **Rejected:** LangChain/LangGraph (see §2), LLM summarization of chat
  (§5.3), Vercel AI Gateway (fragmenting billing/analytics), Claude
  subscription harnessing (ToS, §5.6).
