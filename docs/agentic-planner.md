# Agentic Trip Planner — Living Doc

**Read this first if you're an agent (or human) working on the planner.**
It holds the architecture, the decision log with rationale, and — most
importantly — the learnings from 9+ rounds of live-testing iteration.
Update it when you change behavior or learn something that cost time.

Status: **shipped, iterating on live feedback** · Owner: Sharnam ·
Last updated: 2026-07-27 (parallel plan options — §2d)

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

(2026-07-27: a trip now holds **up to 4 of those objects at once** — parallel
plan options the traveler compares before committing. Everything above still
describes "the itinerary": exactly one option is active, and the map, day
briefs and cards render that one. See §2d.)

## 2. Architecture (and the one fact that shapes everything)

**The browser orchestrates everything; where the trip is *stored* depends on
whether you're signed in.** Signed in, the account's Postgres row is the source
of truth and the browser keeps a working copy in memory that writes through
(`lib/tripStore.ts`). Signed out, localStorage is the source of truth, exactly
as it always was. What did NOT change is the client-first *compute* model —
everything below still holds:

- **The chat route is stateless.** The client sends trip context (spot
  digest + current itinerary + must-sees) with every request.
- **Both tools execute client-side** (no `execute` on the server):
  `update_itinerary` validates + saves through `tripStore`; `get_travel_times`
  computes haversine from spot coords the browser already has. The map
  re-renders the moment a tool call lands mid-stream — the "whiteboard"
  effect is free.
- **Storage goes through `lib/tripStore.ts`** — `peekTrip` / `loadTrip` /
  `saveTrip` / `deleteTrip`, one façade over two backends (§2c). Nothing else
  touches `lib/clientStore.ts` (the localStorage backend) directly.
- **What's still per-browser localStorage**, whichever mode you're in:
  - `pinned.trip.<id>` + `pinned.trip-ids` — signed-OUT trips only
  - `pinned.chat.<id>` — conversation history, signed-out only (signed in it's
    a `chats` row, written at the end of each turn — §4.7)
  - `pinned.itin.<id>` / `pinned.mustsee.<id>` / `pinned.facets.<id>` — a
    visitor's overlays on a *sample/shared* trip they don't own (your own trip
    carries `trip.itinerary` / `trip.query` directly). Small and per-trip.
  - `pinned.owned-ids` / `pinned.pending-trip` — published-by-this-browser ids
    and the through-SSO form stash

### 2d. Parallel plan options (2026-07-27)

Reported from a real Sri Lanka trip: *"sometimes I just want the east coast;
sometimes east, south, then the airport; sometimes I want the national park in
too. I want 3-4 options and to figure out which one to finalize."* The decision
that was missing wasn't between spots — it was between **shapes of trip**, and
the product could only hold one at a time.

- **`Trip.itineraries: Itinerary[]`**, each with an `id` (a model-authored slug
  like `east-coast`) and a `title` naming the tradeoff. Capped at
  `MAX_PLANS = 4`. The pre-options `Trip.itinerary` is **migrated, not
  mirrored**: `normalizePlans` folds it in as the first option on read, and
  the first `savePlans` deletes it — two fields holding a plan is two answers
  to "what's the itinerary".
- **`lib/itinerary.ts` owns the list**: `loadPlans` / `savePlans` /
  `upsertPlan` / `discardPlan` / `activePlan`, over the same two backends as
  before (the Trip object when it's yours, a `pinned.itins.<id>` localStorage
  overlay when it's a sample). `activePlan` falls back to the first option, so
  a selection pointing at a discarded plan can never blank the rail.
- **`upsertPlan` re-reads storage instead of taking the list as an argument.**
  "Build me both shapes" lands **two `update_itinerary` calls in one turn**, and
  React hasn't re-rendered between them — passing the props-held list would have
  made the second write drop the first. Same class of bug as §5.8: don't
  compute from a snapshot you're about to invalidate.
- **Which option is on screen is view state, not trip data** —
  `pinned.plan.<id>` in localStorage, in every mode. On the Trip it would mean a
  network PUT per tab click for signed-in users (§2c), and "the one I was last
  looking at" is honestly per-device.
- **`update_itinerary` gained required `planId` + `title`.** An existing id
  replaces that option; a new slug creates one. Required, not optional, for the
  §4.1 reason: with several plans in play, "which one am I writing" has no safe
  default. At the cap, an unknown id is **refused** — never silently mapped onto
  an existing option — and the tool result hands back the valid ids so the model
  can retry in the same turn. Ids are slugified client-side (they end up in a
  localStorage key and a React key).
- **`discard_plan`** is the fifth tool: "forget the east-only one" shouldn't
  require reaching for the mouse. The UI has a two-step × on each tab as well.
- **UI: a wrapping option strip in the sticky rail header**, one tab per option
  (`①  East coast only  3d`), active filled ink. Deliberately **wraps rather
  than scrolls sideways** — the whole point of options is holding them in
  parallel, and one parked off-screen is one you won't weigh. It shows over the
  **Pins tab too**, because the map draws the active option there as well and a
  control that vanishes while its effect stays visible reads as the plan
  changing by itself. Switching from the pins grid doesn't eject you to the
  itinerary; the chat's plan cards and Compare's Show button do (they mean "go
  look at this one").
- **Compare** stacks all options — day themes plus an "Only here" line computed
  as the set difference against every other option, which is the actual trade.
  Stacked, not columned: at ~420px of rail, a column per option shrinks the day
  themes to two words each, i.e. exactly the detail being compared.
- The spot card gains an **"Also in"** row: half the value of parallel plans is
  seeing that a place survives the choice — or that it's the thing one option is
  *for*.
- **Cost note (§5.2) — the pins are NOT re-billed; the history is.** Measured on
  the 71-spot Sri Lanka trip: the spot digest is 28.4KB and sits **before** cache
  breakpoint 1, together with the persona (14.0KB) and the tool schemas. Options
  live in the volatile block *after* it, so adding a plan cannot invalidate the
  pins — that prefix keeps reading at ~0.1× for the trip's life. What options
  cost is the volatile tail: 9.7KB for one plan, 32.4KB for three (~+6.3K
  uncached tokens a turn, est.). Every option rides along in full because the
  tool is a whole-option replace — the model can only edit an option it can see,
  and a summarized copy would make it rewrite untouched days from memory.
  `MAX_PLANS` is the bound.
- **The bigger line is ordering, not size.** The volatile block sits *in front of*
  the conversation history, so any change to it — a plan write, and now also
  **switching which option is shown** (the `CURRENTLY SHOWN` marker is part of the
  block) — invalidates breakpoint 2 and re-writes the whole windowed history at
  1.25×. By mid-session that history is far larger than the options themselves, so
  it dominates. This is the §5.2 "move itinerary state out of the system tail"
  micro-opt, now worth more than it was. It is **deferred on purpose**: the fix
  needs the volatile block to come *after* the history, and a `role: "system"`
  message inside `messages[]` is Opus-4.8-only — on `claude-sonnet-5` it would
  have to become a trailing user turn (`<system-reminder>`), which changes how the
  model weights trip state on a trust-critical agent. Check `llm-total-costs` in
  PostHog before touching it (§5.5). If the options block itself ever turns out to
  be the top line, the separate fix is to summarize the *inactive* options and add
  a tool that loads one in full — not to shrink the active one.

### 2c. Server-first storage for signed-in users (2026-07-25)

Accounts (§2b) shipped as *sync*: localStorage stayed the working copy and
copies rode up to Postgres. That had a hard ceiling — **~5M characters per
origin** (measured), against ~3.4KB per spot and a chat history that stores
whole itineraries per tool call. A handful of built trips filled it, and then
**every save failed** ("your browser storage is full"), including each step of a
build, while the same trips sat safely in Neon. Reported from prod with a
20-video trip.

- **`lib/tripStore.ts` is the only storage API.** Mode is decided once per load
  from `/api/me`: `server` (signed in) or `local`. Signed in, `saveTrip` writes
  through to `PUT /api/trips/:id` and **nothing trip-shaped is written to
  localStorage at all**.
- **Callers didn't change shape.** Still read → mutate → save. `saveTrip`
  updates the in-memory working copy and notifies subscribers *synchronously*
  (the map re-renders the instant a tool lands), and returns a promise that
  resolves when the write is durable. The runner awaits it at every checkpoint
  so a build that can't persist stops instead of spending extraction calls on
  results it will drop.
- **Coalesced write-behind, one request per trip at a time.** A save landing
  mid-flight re-sends the newest copy when the current PUT finishes. Measured: a
  6-video build = 9 PUTs, never more than 1 concurrent.
- **`lib/sync.ts` became migration, not sync.** It lifts leftover local trips
  (adopting unowned ones) plus their chats into the account and then *reclaims*
  the space — PUT, 200, then delete the local keys, in that order, because
  losing a trip is far worse than a full quota. It skips a trip mid-build to
  avoid racing the runner, and it's a no-op once nothing is left.
- **Signed out is unchanged**: localStorage, no API writes, same quota message.
- **Two kinds of read** (§5.8): `peekTrip` returns the LIVE object for code that
  mutates it (the build's four workers share one object on purpose);
  `snapshotTrip` returns an immutable copy for React state, because handing the
  mutated object to `setState` means the update is invisible and the screen
  freezes. `loadTrip` returns snapshots for the same reason.
- **Nothing on the write path awaits the session probe** (§5.8): `/api/me` is a
  network call and network calls hang; when it did, every save queued behind it.
  An ownerId is enough to know a trip belongs to an account, and the PUT itself
  is bounded by a 30s timeout — a timeout is a retryable failure, a hang is a
  dead build.
- **Reads are cached-first, then revalidated** (2026-07-25b). `loadTrip` returns
  the in-memory copy immediately and refreshes behind the render, so returning to
  a trip in the same session paints in ~40ms instead of re-downloading the whole
  document (measured 1513ms → 42ms on an in-app navigation). The refresh is
  skipped while this tab has unsaved or in-flight changes — ours are newer than
  the server's.
- **`GET /api/trips/:id` carries an ETag** (djb2 over the body) with
  `Cache-Control: private, no-cache` — private because the same URL serves a
  different body per caller. The revalidation sends `If-None-Match` explicitly
  rather than trusting cache heuristics, so an unchanged trip costs a header
  exchange: measured **304, no body** on return vs a 104KB 200.
- **Trips are ~55% smaller** (2026-07-25b): `Spot.morePhotoNames` — the Google
  photo resource names — was ~1.9KB per spot and *never dereferenced* for a spot
  served through `/api/photo` (that route fetches by placeId + index; only the
  count was ever read). It's now `morePhotos: number`. The name list is still
  read for spots that predate `/api/photo`, and `saveTrip` only drops it when the
  spot has a placeId AND a google-sourced photo, so the legacy
  resolve-by-name path keeps working. Every existing trip shrinks the next time
  anything touches it: measured 235.8KB → 104.2KB on a 71-spot trip.
- **Trade-off accepted:** every save is now a network round trip for signed-in
  users, so offline editing is gone (it was never really there — a
  `saveLocalTrip` that succeeded offline still couldn't build without the
  compute endpoints). A failed PUT retries once, then surfaces
  `tripSaveError()`; the build stops rather than silently dropping work.

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
- **Sync, not migration** — *superseded by §2c (2026-07-25)*: writes now go
  straight to the account and `lib/sync.ts` only migrates what localStorage
  still holds, then frees it. Local trips with no `ownerId` are still
  **adopted** on first sweep; trips owned by a *different* account on a shared
  computer are still never pushed.
- **Cross-device open** (`TripView`): one `loadTrip` — the account's copy comes
  back editable, so there's no adopt-into-localStorage-and-re-render dance any
  more. A trip that isn't yours falls through to the sample/published copy,
  read-only with localStorage overlays.
- **Privacy model:** DB trips are served only to their owner — anyone else
  falls through to samples/Blob and gets 404. The Blob community library
  is **explicit opt-in**: the `ShareTrip` button top-right of the trip
  page's right rail (owner-picked spot after rejecting the trip header).
  First click publishes (owner id stripped — the public copy is
  anonymous) and pops a copyable link; once public, clicking just copies
  the link and silently re-publishes so the shared copy stays fresh.
  "Shared" state = `pinned.owned-ids`, so it's per-browser (a second
  device shows "Share" again — harmless, it re-publishes + copies). The
  runner's auto-publish only fires on no-auth deploys where it remains
  the only cross-device path. The
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
Trip ── itineraries?: Itinerary[]    up to MAX_PLANS parallel options (§2d)
          id*, title*                 "east-coast", "East coast only"
          days: ItineraryDay[]      label, date?, theme*, rationale*, stops
            stops: ItineraryStop[]  spotId→Spot.id, time*, durationMin*,
                                    why*, note?, slot?
          stay?  (name, lat?, lng?, note?)   pace?  budget?  updatedAt
     ── itinerary?: Itinerary        LEGACY single plan, migrated on read
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
3. **Every plan change goes through `update_itinerary`**, never prose-only,
   preceded by one short sentence so the stream shows progress before a long
   tool call. **Two modes** (2026-08-02, §4.8): `replace` sends every day and is
   for creating an option or rewriting most of one; `patch` sends only
   `dayPatches: [{index, day}]` and is for editing an existing plan. Write once
   per option per turn, and write last — gather travel times first.
3b. **Shape before pins (initial build only), BOUNDED** — the first plan is proposed
   as a **summary document** (§4.6: title, how the days split, then a section
   per day with area/base + vibe + routing logic, and a `[pins: …]` line naming
   the day's anchor spots for its photo strip — no times, no stop-by-stop
   lists, no tool call), and the user reacts before any pin lands. If their reply
   changes the SHAPE (different bases, different length, a chunk dropped) the
   agent revises the summary **once** — that is what this step is for. Anything
   else commits on the next turn. **At most two summary documents per trip**,
   then it commits regardless, and an unanswered question never blocks the
   commit (state the assumption in the day's rationale and ask after). Course-correcting a rough shape is cheap; reworking a screen of
   placed pins is overwhelming. "Just plan it" — and "plan it", "go ahead",
   "do it" — skips it entirely; later edits go straight through the tool. The
   summary is the ONE exception to rule 3's "never prose-only": it precedes the
   commit, it doesn't replace it. See §4.8 for what happened when this rule had
   no bound.
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
9b. **Only the shown option rides along in full** (§4.9 cost work) — inactive
   options arrive as day themes; `load_plan(id)` fetches one back when the agent
   genuinely needs its detail. Cache *writes* were 43% of chat spend, and most of
   that weight was plans nobody was editing.
9c. **Travel times are tagged** — `source: "road"` is a real routed time to plan
   around as fact; `source: "estimate"` is distance-based and may be argued with
   out loud, but never silently overridden.
10. **Options are for alternatives, edits are for corrections** (§2d) — a
   "what if…" / a different region, theme or length gets a NEW option
   (their current plan survives untouched, which is the point); "swap day 2
   and 3" edits the one they're looking at. Asked for several at once: sketch
   them all in one summary document first, then one `update_itinerary` per
   option in the same turn — and **close with the tradeoff**, what each gains
   and costs and which you'd pick. Listing the plans without comparing them
   leaves the user with the decision they came in with.

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

### 4.6 The opening summary is a document, and the agent picks its pictures (2026-07-25)
Seven days of shape is long, and as one prose blob it read like homework. The
shape message is now a **document**: bold title, a bullet per chunk of the trip,
then per day a `## Day N — theme` heading, a photo strip, `### Morning/Evening`
sub-headings, and `---` between days. Reference was a ChatGPT itinerary reply;
the format is in the persona under "THE SUMMARY DOCUMENT FORMAT".

The photos come from a directive the **model** writes: `[pins: <id>, <id>, <id>]`
under each day heading, 3–5 spots that "show the day". Two decisions worth
keeping:
- **The agent chooses, not a text matcher.** Inferring spots by scanning the
  prose for names looked tempting but picks whatever is *mentioned*, not what's
  *representative* — and it can't tell a fortress from a supermarket. The model
  already knows the ids (it plans with them) and it knows which spot carries the
  day, so it names them. The renderer resolves ids first and spot *names* as a
  fallback, because a model that writes a name instead of a uuid should still
  get its picture (§4.1: prose is steering, so build for the sloppy case).
- **Unresolvable = render nothing.** A directive naming ids we don't have
  produces no strip and, critically, never leaks the raw `[pins: …]` text into
  the conversation.

Only the first three pins get a picture; extras become a `+N` badge on the last
tile, so a 5-spot day and a 3-spot day are the same shape. Each tile selects its
spot — same selection as a map pin or grid tile — which makes the summary
navigation, not decoration. `FormattedText` grew headings (two levels: the day
at the title step, its parts at body/medium — all a ~400px rail can carry) and
`---` rules to support it. Cost: the summary is ~3× the old skeleton's output
tokens; worth it for the moment the plan first lands.

### 4.7 Persist completed turns, and don't let history impersonate a live failure (2026-07-25)
Reported: a Switzerland trip built a full itinerary, the user navigated away and
came back, and the panel showed **"The connection dropped before the plan
arrived — Try again"** above a "Thinking…" block cut off mid-sentence. The plan
was fine and on the map; two separate bugs made it look otherwise.

**1. A mid-stream snapshot got stored.** Chat persistence was debounced against
streaming churn (400ms local, 2500ms to the account). A debounce is a race, not
a rule: a long think outlasts it, so the pause between reasoning and the reply
was long enough for a save to land — an assistant message holding *only* a
reasoning part — and then the user navigated before the real turn was written.
Worse, §2c had just made the account copy the only copy for signed-in users, so
the unmount flush (which wrote localStorage) had become a no-op and the pending
account push died with the page. Fix: **persist only between turns** (`busy`
gates the effect) and **push the moment a turn ends**, not on a timer — one
write per turn, nothing left pending for a navigation to cancel. Plus a
`sendBeacon` on `pagehide` for a real unload, which needed `POST` on the
messages route (beacons are always POST; a normal fetch dies with the document
and `keepalive` caps the body at 64KB).

**2. The "stream died" heuristic couldn't tell live from loaded.** It was
derived purely from the shape of the last message (`role === "user"`, or an
assistant message with no text and no tool part), so *any* conversation that
ended that way — including one merely restored from storage — rendered the red
retry box. Fix: it now also requires that a stream actually ran in this session,
and `sanitizeChat` drops a trailing assistant message that never got past its
reasoning, so the truncated "Thinking…" ghost goes with it. A conversation whose
tail was lost now reads as the user's last message, quietly, with the plan intact
on the map.

Lesson worth keeping: **a debounce is not a durability mechanism.** Persist on
the event that makes the data worth keeping (a turn completing), and treat
"restored from storage" as a different state from "just happened" whenever the UI
says something about *now*.

### 4.9 The plan can only be as good as the map, and the map didn't know where it was (2026-08-02)

Same product pass as §4.8. Everything above is about the agent; this is about
what the agent has to work with, which turned out to be the harder ceiling.

**Measured on the committed sample maps, against each destination's real extent:**

| Trip | Latitude covered | Longitude | Spots outside the destination |
|---|---|---|---|
| Sri Lanka | 28% | 77% | 0 |
| Hokkaido | 24% | 24% | 0 |
| Tbilisi (a city) | 679% | 919% | 4 |
| East Coast SL | 132% | 1404% | 16 of 43 |

Two opposite failures from one missing fact — nothing ever resolved what the
destination *is*:

- **Under-coverage on countries.** "Sri Lanka" has 70 of its 71 spots south of
  7.0°N: no Sigiriya, Kandy, Ella, Yala or Colombo. `curateVideos` optimised the
  first 20 for distinct *channels* and never for distinct *places*, so twenty
  "Sri Lanka travel guide" videos converged on the same coastal circuit. The
  traveler sees 71 pins and cannot tell that most of the country is missing —
  and it's why an "options" request produced a near-duplicate: there was no hill
  country to build an alternative from.
- **Over-spill on cities.** Tbilisi carried Svaneti (~9h away); East Coast Sri
  Lanka pinned "Maldives". The map auto-fit to those outliers, so a three-day
  walkable plan rendered as one dot.

Fixes, in the order they matter: `geocodeBounds` resolves the extent once at
discover and stores `Trip.bounds`; `applyVideoResult` flags anything outside as
`outOfBounds` (kept, hidden from the fit / the grid / the spot digest, one tap
from coming back — deleting a creator's real recommendation is worse than the
problem); `planSearchQueries` returns `scale` + named `subAreas` and dedicates a
query to each; `curateVideos` must cover every sub-area with ≥2 videos *before*
optimising channel diversity, and returns a coverage map so it has to account for
each one.

**Extraction had the same shape of problem.** On the shipped samples: Galle Fort,
Black Fort, Narikala Fortress and Chronicles of Georgia all `other`; a folk
museum `other`; three beach clubs `stay`; a 7-Eleven and an unnamed Airbnb pinned
as places to go; Tbilisi with **zero** `food` spots across 28 pins, which left
the MEAL LOGIC rules with nothing to act on. Prose said "pick the SINGLE category
that best fits" and "skip generic mentions" — and drifted. The fix is §4.1 again:
a **required `category_reason`** placed before the category, a stated 1-in-10
ceiling on `other`, `stay` defined as somewhere you sleep, and a *named* list of
things never to pin. `scripts/recategorize-samples.mts` backfilled the shipped
trips (Tbilisi 21% `other` → 0%).

**And the first personalisation question was working against the traveler.** The
must-see picker was top-3 by mention count across all categories, so a Sri Lanka
map that's 31/71 food asked a first-time visitor whether they must include
`Shady Lane`, `Nomads` and `Petty Petty`. Now weighted by how iconic a category
is, boosted by stated interests, and never three of one category — the same trip
now offers Udawalawe National Park, Weligama Beach and Shady Lane.

Lesson: **a signal that's easy to compute is not the same as the signal you
want.** Mention count is a great quality signal *within* a category and a bad one
across categories; channel diversity is a great proxy for perspective and no
proxy at all for geography. Both looked fine until someone read the output as a
traveler.

**Postscript (2026-08-04): the coverage note was gated on the wrong thing.** It
rendered as soon as `trip.spots.length > 0`, which since B4 (reveal the map as
it fills) means *after the first video of twenty*. A traveler building "Greece"
watched "**Your map doesn't cover everything** — nothing yet for the
Peloponnese, Mykonos, Crete, Thessaloniki" sit there for several minutes,
listing the exact regions the remaining nineteen videos were about to cover,
then vanish. Every word true of a finished map; pure anxiety about one still
being built. Now gated on `buildSettled` — every video `done` or `error`, and
the trip out of `processing`. `throttled` is deliberately not terminal: that
build is paused, and the retry will add spots.

Lesson, and it generalises past this one card: **a warning about incompleteness
must be gated on completeness, not on having data.** "We have some spots" is
the cheapest available proxy and it's the wrong one — during the exact window
where the traveler is most anxious, it is guaranteed to be wrong.

### 4.8 A rule with no bound will run away, and a whole-plan write is the tax (2026-08-02)

A nine-trip product pass, driven as a real traveler, found the shape-first rule
(§3b) eating the product it was meant to protect. Measured on the sample maps:

- **Two of four re-run journeys ended with NO itinerary at all.** Sri Lanka: four
  user messages, 335 seconds, `get_travel_times` every turn, `update_itinerary`
  never. The third reply was a complete, well-written ten-day plan — *in chat
  prose*. The traveler ends up with an itinerary they can't see on the map,
  can't compare, and that was never saved.
- The agent presented the same shape document twice and closed **every** turn
  with a question, so there was always one more round before committing.
- "Four days, keep it easy. **Plan it.**" still produced a shape and a
  "shall I go ahead?".

Two fixes, and the second is the one that holds:

1. **Persona** (§3b): present the shape once, commit on the next message whatever
   it says, never let an open question block the plan, widen the fast path, and
   only close with a question when the answer would change the plan.
2. **A structural backstop.** `needsCommitNudge` (PlannerChat) watches the full
   history for two day-structured assistant turns with no `update_itinerary`
   while the trip still has no plan, and sets `commitNow` on the request; the
   route turns it into a hard `COMMIT_NUDGE` line in the volatile block. Narrow
   on purpose — any committed plan switches it off for good.

**The write itself was the other half.** `update_itinerary` was a whole-option
replace, so "swap day 2 and 3" on a ten-day plan regenerated 35+ stops of JSON.
Measured consequences: a 308-second turn (the route's ceiling is 300), two and
three writes of the same option inside one turn, and intermittent
`AI_JSONParseError` on the oversized payload. `mode: "patch"` with
`dayPatches: [{index, day}]` fixes the economics; `applyPlanUpdate` in
`lib/itinerary.ts` does the read-resolve-validate-write atomically, because two
tool calls can land in one turn before React re-renders (§2d/§5.8) and a base
taken from props would silently drop the first.

Measured after, same scenarios: Hokkaido "just plan it" 232s → **27s**; Tbilisi
edit 71s → **22s**; Sri Lanka edit 308s → **33s**; Koh Tao options 0 plans →
**3 options**. The one thing that did NOT fully hold is "one write per turn" on
the *initial* build of a long trip — the agent still occasionally writes, checks
travel times, and rewrites. Feedback beats prohibition here: `applyPlanUpdate`
returns a warning in the tool result when a full replace changed ≤2 days, which
is the channel the model actually reads.

**Lesson worth keeping: a behavioural rule needs a bound and a fallback.**
"Sketch the shape first" is good guidance and became a trap because nothing said
when to stop sketching. Pair every soft rule with a structural check that fires
when it runs away — and give the model a cheap way to do the right thing
(`patch`) rather than only a rule forbidding the expensive one.

### 4.10 Half of every transcript was the half we threw away (2026-08-03)

**What was wrong.** A 15-minute travel video is maybe a third place
recommendations. The rest is orientation — "nowhere takes card under 20 lari",
"the road to Kazbegi shuts with the snow", "the dogs with ear tags are
vaccinated", "don't flag a street taxi, they quote tourists triple". We read
every second of that, used the place-attached slice for a pin's
`thingsToKnow`, and binned the remainder. Twenty videos of it is the briefing a
traveler actually reads *before* they start picking pins, and we were the only
product in a position to assemble it: not from a guidebook, from the specific
creators this specific map was built from.

**The shape.**

1. **Capture is free.** The transcript is already in context in `extract.ts`;
   `notes` rides along on the same call. No extra request, no extra latency.
2. **A note is not a tip.** The split that made the rule teachable: advice that
   only makes sense at one place is that spot's `thingsToKnow`; advice that
   would still be true if that place didn't exist is a note.
3. **Receipts, not vibes.** Every note carries a near-verbatim `quote` and the
   second it was said at. This is the same anti-hallucination lever as spot
   mentions — the model knows a great deal about Georgia and none of it is
   allowed in — and it doubles as the UI: a channel chip opens the video at
   that timestamp. Attribution is the entire difference between this section
   and asking a chatbot about the country.
4. **Synthesis is the one model call.** Twenty videos say "bring cash" twenty
   times. Rendering the raw pile reads as padding and teaches the traveler to
   never open the section again. Merging near-duplicates *while keeping the
   numbers* is the one job a model is unambiguously good at.

**What made the output good, and it wasn't the topic list.** Two instructions
did nearly all the work. *Omit thin topics* — a topic with one throwaway remark
is not a section, and four real sections beat twelve padded ones. And a literal
banned-phrase list ("rich culture", "friendly locals", "something for
everyone", "be respectful of local customs"), because every one of those is
true of everywhere and the model reaches for them by default. Verified against a
note set seeded with two deliberate pieces of filler: both were dropped, and the
`lifestyle` and `known-for` sections simply didn't appear. The safety rule
earned its place too — creators routinely distinguish solo from with-people and
day from night, and "it's generally safe" is what you get if you don't forbid
the averaging.

**Timing decisions.** The briefing is written *after* the build flips to
`ready` and is never awaited, because time-to-a-usable-map is the number that
matters and a nice-to-have must not spend it. That leaves a hole — a reload in
that window loses it and no build will run again — so the trip page also calls
`ensureBriefing`, which no-ops unless the stored briefing is older than the
trip's notes. Same reasoning as `resumeInterruptedBuilds` (§ runner).

**Cost.** One Sonnet call per finished trip, ~$0.02 against a build that
already spends ~20 extraction calls. `VIDEO_CACHE_VERSION` had to go 2 → 3:
without it every already-cached video contributes zero notes, so the briefing
would be thinnest on exactly the popular destinations where the cache hits
most.

**Postscript (2026-08-04): three things this got wrong.**

*One bad field killed a whole video.* `zodOutputFormat` gives the SDK a zod
parser, and `maybeParseMessage` then validates the whole response
all-or-nothing and **throws**. A Crete video came back with `spots[9].category`
outside the enum and we lost the transcript, the other twenty spots, the notes,
the paid model call and a bench slot — over one label. Worse, the thrown
message is what the build screen renders next to the video title, so a traveler
was shown a zod validation dump listing all fourteen category values, wrapped
across fifteen lines and overflowing the card (`.video-chip .vchannel` had none
of the clamping `.vtitle` had). Now: the JSON Schema still steers generation,
but `parse` is stripped from the format and `parseExtraction` checks items one
at a time. An unrecognised category is a *labelling* miss, not a bad spot — the
name, coordinates and description are all still good — so it's filed as `other`
and kept. A whole video only fails when the JSON is unreadable, the destination
is missing, or *every* spot failed. **Lesson: an all-or-nothing parser at the
edge of a probabilistic system converts a small error into a total loss.**

*The likely trigger is worth naming:* this schema now carries two enums —
`category` and the note `topic` — and `food-drink` is a topic while `food` is a
category. The prompt now says explicitly that the two lists are not
interchangeable.

*And a briefing could be skipped forever.* `ensureBriefing` sat after the
throttled early-return in `run()`, so a build that ended paused never got one —
and the trip page only asked once, at mount, when the notes didn't exist yet.
Both fixed: the call moved ahead of the branch, and the page re-asks whenever
the trip settles. Separately, trips built *before* this feature have no notes
and no path to any, since transcripts are never re-read; `/api/notes` recovers
them from the video cache, which was repopulated with notes by the version bump.
Cache-only by design — it can never trigger an extraction, which is what makes
it safe to attempt unprompted.

**Still open:** the five committed samples have no briefing. Notes can only
come from transcripts and `scripts/backfill-briefings.mts` needs
`YOUTUBE_PROXY_URL` — from a machine without it, YouTube 400s every caption
request. Run it wherever the proxy is configured. Until then the feature is
invisible on the sample maps, which is what most first-time visitors open.

### 4.11 The agent didn't know the map was still loading (2026-08-04)

**Reported by a traveler:** *"as soon as the video starts getting scraped, the
points start appearing on the map and I'm on the map screen… I would end up
answering the messages or initiating a message. Now the agent does not have all
the context because not all the pins are marked. It plans a very subpar
itinerary."*

**This is a side effect of B4.** The full-page build screen used to hide the
planner until the build finished. Since B4 (reveal the map as it fills) it
lifts the moment the *first* spot lands — ~40 seconds into a four-minute build.
So the traveler gets a complete-looking planner with 8 of an eventual 71 pins.

**The part that made it dangerous: nothing hedged.** `buildPlannerContext`
handed over `spots` with no indication it was partial, so the agent had no way
to know. It planned a confident week in Greece out of Mykonos, and a
confidently wrong plan is indistinguishable from a good one — worse than no
plan, because the traveler has no reason to doubt it.

There was a second, quieter casualty: `intakeQuestions` builds "Anything you
must include?" from `pickIconicSpots(trip)`. Answer it three videos in and
three Mykonos bars become hard must-includes for the whole trip — a constraint
that outlives the build and shapes every later plan. (Not fixed here; it's part
of the deferred UX pass.)

**Fix, in two layers, because one wasn't enough.**

1. *Tell it.* `PlannerContext.build = { videosRead, videosTotal, running }`, and
   a `buildBlock` in the volatile context — **volatile, not the trip header**,
   because it changes on every landed video and the header carries the spot
   digest, the most expensive thing in the prompt to invalidate.
2. *Enforce it.* `applyPlanUpdate` refuses while `running` and hands back a
   `rejected` string. §4.1 again — prose is steering, and §4.8 is what happens
   when a behavioural rule has no structural backstop. The tool result is the
   channel the model demonstrably reads and corrects itself on; it's what made
   the patch-mode nudge work.

`COMMIT_NUDGE` is suppressed while the build runs — the two instructions are in
direct contradiction and the nudge is the more forceful.

**Gated on `running`, not on "every video read"**, and that distinction is the
whole of `buildProgress`. A build that gave up rate-limited leaves videos
queued forever; blocking on those would strand the traveler on a usable map
they're not allowed to plan. The coverage warning asks the *other* question
(`settled`) because claiming regions are missing is only safe once nothing more
is coming at all.

**Verified live, both directions.** Mid-build (3 of 20 videos, 8 spots, build
frozen), asked to "just plan it": no plan written, and the agent said —

> "The map's still filling in — only 3 of 20 videos read so far, so whole areas
> (surf breaks, waterfalls, viewpoints, etc.) probably haven't landed yet. I
> don't want to sketch a plan off a fraction of the picture, but I can use this
> time to nail down the shape of your trip so I'm ready the moment it's
> complete."

— then went into the intake unprompted, which is exactly the behaviour the
deferred UX layer was going to design. Control on a complete build:
`tbilisi-weekend` fixture, 15/15 assertions.

**Lesson: when you make a slow thing visible earlier, check what else that
unblocks.** B4 was a good fix for a ten-minute blank stare. It also handed the
traveler a planner that had no idea it was looking at a sixth of the map.

**Layer 4 — keeping the promise (2026-08-04).** Layers 1–2 stopped the bad
plans; what they left behind was an agent that says *"I'll lay out the days as
soon as the map is complete"* and then goes quiet. The gate lifted in silence
and the traveler had to notice the build had finished and ask again — a strange
thing to ask of someone who was just told to sit tight.

The panel now watches the build land and hands the turn back. Four things made
it non-trivial:

- **The trigger has to be a user-role turn** for the model to answer it, but it
  is *not* something the traveler said. It renders as a hairline event divider
  (`.pm-landed`) rather than a bubble — putting words in their mouth in a
  transcript they can scroll back through is exactly the invented fact the
  persona forbids. (Watch the class name: `.pm-event` was already taken by the
  `find_spots` cards, and the first version silently restyled all of them.)
- **The promise is stored per trip** (`pinned.plan-deferred.*`), not in a ref.
  The wait is precisely when people navigate away, so a ref would miss the one
  case the feature exists for.
- **Any outgoing turn after the map lands clears it**, in the transport rather
  than at one call site. Whether the traveler typed, answered a question card,
  or a tool round-trip carried things forward, that turn already keeps the
  promise — without this the pickup arrives on top of a conversation that
  continued fine without it.
- **It holds while a question card is open.** Barging in would strand the tool
  call, which is the bug §A1 exists to prevent, and would talk over someone
  already mid-answer.

Verified end to end against a frozen build released mid-conversation: the agent
deferred (*"I'll build the full shape once the rest of the map finishes reading
in… I'll pick this back up the moment it's complete"*), the build landed, the
pickup fired, and it opened with *"The full set has landed — 25 spots now."*
The flag cleared, and no user bubble was fabricated.

**Unrelated finding, worth chasing:** `tbilisi-weekend` fails `pace matches what
was asked for` on this branch (4.7 stops/day against a 2–4.5 band) — and fails
*worse* without these changes (5.0). Reproducible across runs, so it is neither
variance nor caused by layer 4. It is the same Relaxed-pace drift first noticed
in the PM audit and still open.

### 4.12 Where you sleep is part of the plan (2026-08-04)

**Reported:** "if I'm going to Bali, I have already booked Uluwatu for 2 days,
Canggu 3, Ubud 4. Maybe I don't know if I should be staying in three different
areas... These are different PNCs that the agent can help me figure out."

**That trip was unrepresentable.** `Itinerary.stay` held ONE `{name, lat, lng,
note}` for a whole trip, so a sequence of bases with nights had nowhere to live
— and basing is the decision that silently determines which spots are even
reachable. Based in Ubud, an Uluwatu day is two hours each way. `Itinerary.bases`
is the fix: area, nights, day range, why, and `stayIds` pointing at the
creator-recommended `stay` spots the map already holds (9 on Koh Tao, 9 on Sri
Lanka) — which is what makes it a recommendation with receipts rather than a
guess.

**The intake never asked.** The persona listed "where they're staying" among
things worth asking, but the client-side form that runs BEFORE the agent didn't
include it, so the fast path never raised it. It's now a question, and
`allowOther` is the important part: someone can type the whole Bali answer into
it in one go.

**Two surfaces, deliberately.** The proposal lands as a card inside the summary
document, before any pin — three lines of prose are far easier to argue with
than thirty placed pins. Once accepted it's written onto the plan and rendered
collapsed at the top of the itinerary, scoped to the ACTIVE option: "east coast
only" and "east, south and the airport" have genuinely different bases, so a
trip-level section would show one option the other's answer.

**What live testing changed.** First run: bases landed on the plan correctly,
and the in-prose block never appeared — because the agent skipped Step 1
entirely. The intake compiles to *"Plan my days."*, which the persona reads as
the documented "just plan it" fast path, so there was no summary document for
the block to live in. Two fixes: the where-to-stay block became step 3 of the
numbered SUMMARY DOCUMENT FORMAT rather than a bullet after it (an aside reads
as optional), and when the stay answer is unresolved the intake now compiles to
*"tell me which areas to base in… then plan the days around that"* instead.

**Lesson: a fast path is a policy, and policies need exceptions.** "Skip the
shape when they say just plan it" is right when the structure is settled and
wrong when it isn't — days built on a base the traveler never chose aren't days
they can agree to.

**On booked travelers:** plan around what they have, and flag the split only
when it's genuinely costly and still actionable ("two nights here, one spot on
your map, the rest 90 minutes north"). Never because we'd have chosen
differently — they've paid, and that advice is noise.

### 4.13 A refusal is a completed tool call (2026-08-04)

**Reported:** "planner got stuck and kept repeating in this state… the prose
came 8 times."

**Two independent unbounded loops, and one of them I built.** §4.11 made
`update_itinerary` REFUSE while the map is still building. A refusal comes back
through `addToolOutput` as a normal tool output — and a completed tool call is
exactly what `lastAssistantMessageIsCompleteWithToolCalls` auto-resends on. So
the agent got the turn back, tried again, was refused again, and handed the
turn back again. Eight identical passes of the same reasoning, each a full
Sonnet turn on a ~30KB prompt, none of which could ever have succeeded because
the thing it was waiting on was a build that had not finished.

The refusal text says "Do NOT call update_itinerary again yet". That is
steering, and §4.1 is the standing lesson about what steering is worth without
a structural bound. `sendAutomaticallyWhen` now carries the bound: two refused
writes since the traveler last spoke and the turn stops being handed back. Counted
since their last message, because their next message is a genuinely new
situation and deserves a fresh budget.

**The second loop was older and worse.** The "retry a thrown tool call ONCE"
guard was a `Set` of message ids — but `regenerate()` replaces the last
assistant message with a NEW one carrying a NEW id, so a failure that
reproduces is never recognised as the same failure. "Retry once" was really
"retry forever". Now a counter, reset when the traveler speaks.

**Lesson: when you add a way for something to fail, check what auto-resumes.**
The gate in §4.11 was correct and well-tested in isolation; what it didn't
account for is that the SDK treats "refused" and "succeeded" identically,
because both are a tool call with an output.

**Also reported, and unrelated:** scrolling up to read while a reply streamed
yanked you back to the bottom. The follow-the-stream effect ran on every chunk
and set `scrollTop` unconditionally. It now sticks to the bottom only while the
traveler is already there — the moment they scroll up they have taken control
and keep it until they come back down. Their own messages always scroll into
view regardless, because that one is theirs.

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

### 5.9 One trip, one trace — and evals on real traffic (2026-08-04)

**A 20-video build was landing as 22 traces.** Discovery took a `randomUUID`,
each extraction took `video-<id>`, the briefing took `trip-<id>`. Every one was
locally sensible and the whole was useless: nothing could answer "what did
building this trip cost", and one traveler's build read as 22 unrelated
conversations.

The video id was chosen because *extractions are cached cross-trip* — but that
conflated two different keys. The **cache** is keyed by video and stays that
way. The **trace** describes this traveler's build, so it's keyed by trip
(`buildTraceId`). On a cache hit no model call happens and no generation is
emitted, which is the honest record — the trip that paid for the read is the
one that shows it.

The tier above was missing too: `$ai_session_id` was set by the chat route but
not by any build call, so the two halves of one trip's history didn't line up.
`tripProperties` now sets it everywhere. The hierarchy:

```
session = trip
├── trace build-<tripId>   plan-search-queries, curate-videos, 20× extract-spots, briefing
├── trace <sitting 1>      planner-chat turns
└── trace <sitting 2>      …
```

**Lesson: a trace id is not a cache key.** They answer different questions —
"can I reuse this work?" versus "what happened for this person?" — and the one
that's convenient at the call site is usually the wrong one.

**Evals now run on production traffic.** PostHog's native evaluations
(`/docs/ai-evals`) attach to `$ai_generation` with no new instrumentation,
because `$ai_output_choices` already carries `tool_calls` — the actual
`update_itinerary` payload. Three are configured:

| Evaluation | Type | Notes |
|---|---|---|
| Pace matches what the traveller asked for | Hog (free) | Stops/day vs the intake pace, same bands as the fixtures |
| Plan was written from a finished map | Hog (free) | Guards §4.11 — fails if the input still says the map is building |
| Plan serves what the traveller actually asked for | LLM judge | Relevance of the committed itinerary. Needs an Anthropic key |
| Summary document is worth saying yes to | LLM judge | Relevance of the PROSE SHAPE, before any pin is placed. Needs a key |

**Both halves of the flow get judged, and the prose half matters more.** The
shape document is what the traveller actually says yes to (§4.6) — a plan built
on a shape they should have rejected is wasted work — and it carries no tool
call, so anything conditioned on one is blind to it. Its judge has a failure
mode the plan judge doesn't need: *could this have been written about
anywhere?* A sketch of "explore the old town, beach day, soak up the
atmosphere" is fluent, on-topic, and gives the traveller nothing to push back
on.

**Turn-shape properties are what make this affordable.** `wrotePlan`,
`wroteShape`, `planIsPatch`, `plannedDays` and `plannedStops` are emitted on
every `$ai_generation`, so a judge runs only on the turns it can say something
about instead of sampling everything and returning N/A. `plannedDays`/
`plannedStops` also fixed a *wrong* eval: the first pace check counted
`spotId` occurrences in `$ai_output_choices`, which is truncated at
`MAX_CONTENT_CHARS` — so it undercounted exactly the biggest plans, the ones
most likely to be overpacked. Measuring before truncation is exact.

Worth knowing for future evals: Hog gets `properties.*` and supports
`splitByString`/`ilike`, and returning `null` marks a generation N/A. There is
also a **trace target** that waits for a conversation to settle, so
conversation-level checks are possible — bearing in mind a trace is one
*sitting*, not the whole conversation.

### 5.10 A trace id is not a cache key, and a cache key is not an identity (2026-08-04)

**One mountain, three pins.** A Skye trip produced "The Quiraing" (3 creators),
"Quiraing", and "Quiraing Mountains (Trotternish Ridge)" as three separate
spots. Matching was exact equality on `normalizeName`, so three strings meant
three places.

**The defence that should have caught it was dead code.** `extractSpots` takes
`knownSpotNames` and instructs the model to "reuse the EXACT same name string
so it can be merged" — but `processVideoRaw` calls it with an EMPTY array, and
has to: extractions are cached cross-trip, so they cannot depend on what any
one trip has already found. **The caching decision silently disabled the
consistency mechanism, and nothing downstream was strengthened to compensate.**
The instruction has probably never run in production.

So matching became post-hoc and layered by trust (`findDuplicate`):

1. **Google place id** — authoritative. Same id, same place, whatever it's called.
2. **Exact normalized name** — the old rule, unchanged.
3. **Articles and parentheticals stripped** — "The Quiraing" == "Quiraing".
   Still exact, but bounded at 50km so a far-away namesake can't collapse in.
4. **Word containment + same category + within 3km** — the loose rule, so it
   carries every guard. Two *different* Google ids veto it outright: that's
   Google saying these are different places, and a word-overlap heuristic
   doesn't get to overrule it.

**The asymmetry that set the tuning:** under-merging shows an ugly duplicate
pin — visible, annoying, recoverable. Over-merging silently destroys a real
recommendation, and nobody ever notices. When in doubt, don't merge. Verified
against the reported case plus five over-merge traps ("Sairee Beach" vs
"Sairee Beach Bar", "Galle Fort" vs "Galle Fort Lighthouse", two "Blue
Lagoon"s, differing Google ids).

**Measuring it needs both halves, and they're different instruments.** Within
one video, a Hog eval on `extract-spots` catches two names for one place. The
cross-video case — the one actually reported — is invisible from any single
generation, because each extraction is cached trip-independently and cannot
know what the others called a place. That half is the
`duplicate_spots_detected` product event, emitted at build completion from a
deliberately looser scan than the merge uses: it reports, so it can afford
false positives the merge cannot.

### 5.5 Verify costs in PostHog, decide with data
Every planner turn emits `$ai_generation` (span `planner-chat`, tagged
tripId/tripName) with token + cache fields. Before optimizing anything
cost-related (model splits, summarization, Routes API), check
`llm-total-costs` there first. From turn 2 of a session,
cache_read should dominate input tokens — if not, a silent cache
invalidator crept in.

**User-level attribution (2026-07-24, post-accounts).** Every
`$ai_generation` is keyed to the signed-in account: `distinctId` = the
session user's id (`google:<sub>`), a plain `userId` event property for
breakdowns, and `$set: {email, name}` so PostHog person profiles/cohorts
populate. Anonymous callers keep the old behavior (`distinctId` = traceId,
`$process_person_profile: false`). The user always comes from the session
cookie SERVER-side (client-sent ids would be spoofable). Plumbing: the chat
route passes the user explicitly into its capture opts (its callbacks run
under `after()`, where ambient context is risky); the discover/process-video
pipeline uses `withLlmUser()` — request-scoped AsyncLocalStorage in
`lib/llm.ts` — so `extract.ts`/`discover.ts` needed no signature changes.

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

### 5.8 React state must not be the object you mutate (2026-07-25c)
Reported: a 20-video build sat on "0 of 20" with every video spinning, and the
trip turned out to be fully built — reload and the map was there. Not the
network, not the build: **the loader never re-rendered.**

`TripView` kept the store's live trip in state, and everything that writes a trip
mutates it in place (the runner sets `videos[i].status`, the agent pushes onto
`spots`). So `setTrip(peekTrip(id))` handed React the object it was already
holding: `Object.is` equal, update skipped, screen frozen — while the same
mutations sailed into Postgres. It only *looked* intermittent because any
unrelated re-render would suddenly reveal the mutated state.

Invisible before §2c because every read was a fresh `JSON.parse` of localStorage,
so each render got its own copy for free. The store now separates the two kinds
of read: **`peekTrip` is the live object** (build workers run four at a time and
rely on sharing it — cloning there would drop merges) and **`snapshotTrip` is an
immutable copy for React**. A shallow copy is not enough: the arrays the screen
reads are the ones being mutated.

Verified before/after with the render log: without it, 6/6 videos folded and 8
store notifications produced 4 renders, all reading "0 done"; with it, renders
climb 0 → 1 → 2 → 4 → 5 → 6.

Two harness traps this cost time on, both worth remembering:
- **Assert on renders, not on sampled DOM.** The first three versions of the test
  polled the DOM and "passed" while the screen was frozen, because the build
  finished between samples. `console.log` in the component and assert on the
  sequence.
- **Playwright serializes route handlers per page.** `await` inside one queues
  every other matching request behind it, so a "parallel" build under test runs
  serially and a stall in the harness reads as a stall in the product.
- And the screen under test disappears on its own: the build screen is gated on
  `spots.length === 0`, so fakes that return spots replace it within a frame.
  Fakes that return none keep it on screen.

### 5.7 Measure the wire, not the promise (2026-07-25)
Verifying the ETag work, `page.on("response")` reported **200** for requests the
server had answered **304** — a revalidated response is handed to JS as the
cached 200, so both `status()` and `body()` describe the resolved resource, not
what crossed the network. Two consequences worth remembering: read the server's
own log (or a proxy) when the claim is about bytes, and don't verify caching
through `page.goto`/`reload` in Playwright — its contexts don't reuse the HTTP
cache across full loads, so a real win looks like no win. The honest test was an
in-app (client-side) navigation, where both the in-memory copy and the
conditional request are actually exercised.

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
| `lib/itinerary.ts` | Zod schemas (tool input, incl. `ask_questions`/`find_spots`/`discard_plan`), validation/normalization, the **plan-option list API** (`loadPlans`/`savePlans`/`upsertPlan`/`discardPlan`/`activePlan`/`normalizePlans`, §2d) + `applyPlanUpdate` (the atomic read-resolve-validate-write behind `update_itinerary`, incl. `mode: "patch"` — §4.8) + must-see and active-option overlays, haversine + travel estimates, spot digest builder, day colors, `PlannerContext` |
| `lib/findSpots.ts` | `find_spots` tool's client orchestration — a scoped mini-`runner.ts`: reuses `/api/discover` + `/api/process-video` + `applyVideoResult` to add new pins for an area/interest mid-chat (4 videos, parallel fetch / apply-at-end, dedup vs existing). Map re-renders via the trip subscription — no callback |
| `components/PlannerChat.tsx` | Chat UI: useChat wiring, client tool execution, history persistence (save/sanitize/window), reasoning + tool part rendering, must-see bar, auto-growing input, first-trip nudge; `FormattedText` light-markdown renderer (paragraphs, lists, two heading levels, `---` rules, `[pins: …]` → `PinStrip` photo row, §4.6); `ConversationalIntake` opening intake on every viewport; `QuestionFlow` tap-through form for the `ask_questions` tool |
| `components/TripView.tsx` | Page shell: 3-panel layout, plan-option/must-see state, day chips, `PlanTabs` (option switcher) + `PlanCompare` (side-by-side, §2d), `DayBrief` (timeline + rationale), `SpotCard` ("In your plan" + "Also in" + star) |
| `components/TripMap.tsx` | Leaflet map: pill markers (star badges), plan overlay (numbered day pins, polylines, stay pin), day-fit behavior |
| `lib/types.ts` | `Itinerary`/`ItineraryDay`/`ItineraryStop` on `Trip` (stored shapes — optional fields for back-compat); `Trip.itineraries` (options) + the legacy `Trip.itinerary`; `Trip.ownerId` |
| `lib/auth.ts` + `app/api/auth/*` + `app/api/me*` | Google SSO, session cookie, dev-user fallback (§2b) |
| `lib/db.ts` | Postgres (Neon prod / PGlite dev): users, trips, chats + ownership-enforcing queries (§2b) |
| `lib/tripStore.ts` | **The storage API** (§2c): mode probe, in-memory working copy, coalesced write-through to `PUT /api/trips/:id` (signed in) or localStorage (signed out), save-error reporting |
| `lib/clientStore.ts` | The localStorage backend — signed-out source of truth; reached only through `tripStore` |
| `lib/sync.ts` + `components/SyncAgent.tsx` | One-way **migration** of leftover local trips + chats into the account, then reclaims the localStorage space (§2c); adoption of pre-account trips |
| `lib/useSession.ts` + `components/AccountMenu.tsx` | Client session cache (one `/api/me` per load), avatar menu |
| `lib/analytics.ts` + `lib/track.ts` + `app/api/events` | **Product** events (as opposed to `$ai_generation`): build started/completed/failed, first pin visible, itinerary committed, tool errors, question cards. Allowlisted server-side so a public endpoint can't mint event names; keyed to the session user |
| `lib/routes.ts` + `app/api/routes` | Real road times for `get_travel_times` (Google Routes, adjacent pairs only, one element per leg). Results are tagged `source: "road" \| "estimate"` — the agent was overruling straight-line numbers out loud (§4.8) |
| `lib/geocode.ts` `geocodeBounds` | The destination's real extent, resolved once at discover → `Trip.bounds`. What makes "is this spot part of this trip?" answerable (§4.9) |
| `lib/briefing.ts` | Shared briefing half (§4.10): the closed topic table with each topic's remit, note dedupe/caps, staleness. Dependency-free — client and server both import it |
| `lib/briefingSynth.ts` + `app/api/briefing` | The one model call that turns a trip's raw notes into "Before you go" sections. Server-only (Anthropic SDK) |
| `app/api/notes` | Cache-only note recovery for trips built before briefings existed. Never falls through to an extraction (§4.10 postscript) |
| `components/TripBriefing.tsx` | The collapsed section above the pins; per-topic prose with channel chips linking into the video at the second it was said |
| `scripts/recategorize-samples.mts` | One-off relabelling pass over the committed sample trips against the tightened category rules (§4.9) |
| `scripts/backfill-briefings.mts` | Gives the committed samples a briefing by re-reading their transcripts for notes only — never touches their spots (§4.10). Needs `YOUTUBE_PROXY_URL` |
| `scripts/fixtures/` | The planner's regression net — scripted journeys on the sample maps asserting schema completeness, meal logic, weekday accuracy, pace, turn budget, one-write-per-turn, and no leaked internals (§8) |
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
- **Run the fixture suite for any persona or tool-schema change.** Every rule
  in §3 lives in a prompt or a zod schema, and `tsc` cannot see any of them.
  `scripts/fixtures/` drives the real client through five scripted journeys on
  the committed sample maps and asserts on what the traveler ends up with —
  schema completeness, meal logic, weekday accuracy, pace, the turn budget,
  one write per option per turn, and that nothing internal leaks into the
  thread. It needs a dev server with a real key, and Playwright out of tree:
  ```bash
  PORT=3010 npm run dev &
  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright
  npx playwright install chromium
  PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright/index.mjs npm run test:fixtures
  ```
  Real tokens (~$0.30-1.00 per scenario), so it's a nightly + manual job, not a
  PR gate. `npm run test:fixtures tbilisi-weekend` is the cheap smoke test.

## 9. Deliberate non-goals / deferred

- **Google Routes API travel times** (v2) — haversine × city-speed is
  deliberately "good enough to structure a day"; upgrade lazily
  (adjacent pairs only, 10K free elements/mo) when estimates prove off.
- **BYOK** (v3) — friends bring their own Anthropic key via header →
  `createAnthropic({apiKey})`; localStorage-only, never stored server-side.
- **Proposal/accept diffs, drag-to-reorder + locks, opening hours from
  Places, stay-area recommendation mode with candidate pins.**
  (Cross-device sync shipped 2026-07-23 with accounts — §2b; parallel plan
  options shipped 2026-07-27 — §2d.)
- **Options deferred within §2d:** merging two options ("take day 3 from the
  park plan"), a "finalize" state that archives the losers, and per-option
  chat threads (one trip is still one conversation — §5.4).
- **Rejected:** LangChain/LangGraph (see §2), LLM summarization of chat
  (§5.3), Vercel AI Gateway (fragmenting billing/analytics), Claude
  subscription harnessing (ToS, §5.6).
