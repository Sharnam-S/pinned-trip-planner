# Agentic Trip Planner — Design Doc

Status: **v1 in progress** · Owner: Sharnam · Last updated: 2026-07-19

## 1. What we're building

Today the app answers *"what's worth visiting?"* (YouTube research → spots on a map).
This feature answers the second half: *"when do I visit what?"* — an in-app travel
agent that behaves like a knowledgeable local, interviews the user lightly (budget,
dates, stay, interests), and produces a **day-by-day itinerary** that renders on the
existing map like a whiteboard: day filters, visit order, and route lines.

The trip page becomes three panels:

```
┌────────────┬──────────────────────┬──────────────────────┐
│  Planner   │  Spot cards          │  Map ("whiteboard")  │
│  chat      │  (3 cols → 2 when    │  · day chips overlay │
│  (agent)   │   chat is open)      │  · numbered markers  │
│            │                      │  · per-day polylines │
└────────────┴──────────────────────┴──────────────────────┘
```

**Core principle: the itinerary is a data object, not chat prose.** The agent edits
it via a tool call; the map, cards, and future features all render the same object.
Chat is ephemeral; the itinerary persists on the trip.

## 2. Decisions (and why)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Vercel AI SDK v7** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/react`) | Covers the hard 20%: `useChat` state machine, SSE transport, streaming tool calls, provider abstraction (future Gemini/Haiku split is config). LangChain/LangGraph rejected — abstraction tax, no UI story. |
| D2 | **Model: `claude-sonnet-5`** | Quality is the product in the planner; ~$0.10–0.50 per full session with caching. Extraction pipeline stays on its current model — revisit split after checking PostHog `llm-total-costs`. |
| D3 | **Stateless chat route; client owns all state** | User trips live *only* in browser localStorage (`lib/clientStore.ts`); the deployed server is read-only (`isReadOnly` when `VERCEL`). So the client sends trip context + messages each turn; the server holds nothing. This also makes BYOK trivial later. |
| D4 | **Both tools are client-executed** (no `execute` on the server) | `update_itinerary` must write localStorage — server can't. `get_travel_times` needs spot coords the client already has (haversine). Zero server state, zero server Google cost in v1. |
| D5 | **`update_itinerary` is a full-replace** of the itinerary | Idempotent, trivially validated, no patch-conflict logic. Payloads are small (≤ a few KB). Partial-edit ops can come later if token cost ever matters. |
| D6 | **Itinerary stored as `Trip.itinerary`** for local trips; **overlay key** `pinned.itin.<tripId>` for sample/shared trips | Local trips already round-trip wholesale through `saveLocalTrip`. Sample trips are server-owned and read-only, but a visitor should still be able to plan on one — the overlay keeps their plan without forking the trip. |
| D7 | **Prompt caching**: spot digest lives in one system message with `providerOptions.anthropic.cacheControl: {type:'ephemeral'}` | The spot list is the big, static block (~10–30KB). Cache-read pricing makes multi-turn sessions ~10× cheaper. Volatile content (current itinerary, user prefs) goes *after* it. |
| D8 | **Distance digest in context + on-demand tool** | System prompt includes each spot's 3 nearest neighbors (km) so the agent clusters sensibly without tool round-trips; `get_travel_times` answers specific pair queries. v1 is haversine × mode-speed heuristic; Google **Routes API ComputeRouteMatrix** is v2 (free tier 10K elements/mo; only fetch pairs the plan actually uses). |
| D9 | **Agent proposes, doesn't interrogate** | Dates/interests often already exist in `Trip.query` — seed from them, ask at most 1–2 questions, then put a draft plan on the table and iterate. Encoded in the system prompt. |
| D10 | **Auth: server `ANTHROPIC_API_KEY` in v1; BYOK header in v3** | Matches the existing pipeline. Subscription/OAuth harnessing is banned by Anthropic's consumer ToS (enforced 2026-01/02) — API is the only compliant path. |
| D11 | **PostHog `$ai_generation`** captured in the route's `onFinish`, reusing `tripProperties()` from `lib/llm.ts` | Keeps the chat visible in the same LLM-analytics traces as the pipeline. |

## 3. Data model (ERD)

```
Trip (existing)                      Itinerary (new, optional on Trip)
┌───────────────────┐               ┌─────────────────────────────┐
│ id                │ 1 ──── 0..1   │ days: ItineraryDay[]        │
│ name              │               │ stay?: Stay                 │
│ spots: Spot[]     │               │ pace?: packed|balanced|     │
│ query?: TripQuery │               │        relaxed              │
│ itinerary?  ◄─────┼───────────────│ budget?: string             │
│ ...               │               │ updatedAt: ISO string       │
└───────────────────┘               └─────────────────────────────┘
                                       │ 1..7        │ 0..1
                                       ▼             ▼
                       ItineraryDay              Stay
                       ┌──────────────────┐     ┌──────────────────┐
                       │ label: "Day 1"   │     │ name              │
                       │ date?: yyyy-mm-dd│     │ lat?, lng?        │
                       │ theme?: string   │     │ note?             │
                       │ stops: Stop[]    │     └──────────────────┘
                       └──────────────────┘
                          │ 0..n  (ordered = visit order)
                          ▼
                       ItineraryStop
                       ┌────────────────────────────┐
                       │ spotId ───► Spot.id (FK)   │
                       │ slot?: morning|afternoon|  │
                       │        evening             │
                       │ note?: string (agent tip)  │
                       └────────────────────────────┘
```

Invariants (enforced by `lib/itinerary.ts` zod schema + client-side validation):
- `stops[].spotId` must exist in `trip.spots` (unknown ids dropped with a warning
  returned to the model so it can self-correct).
- A spot appears at most once across all days (first occurrence wins).
- ≤ 14 days, ≤ 10 stops/day (sanity caps).
- Spots not referenced anywhere = "Unassigned" (derived, not stored).

## 4. Request flow

```
user types ──► useChat (PlannerChat.tsx)
                 │  POST /api/trips/[id]/chat
                 │  body: { messages: UIMessage[], context: {meta, spots digest,
                 │          distances, itinerary} }
                 ▼
        route.ts: streamText({ model: anthropic('claude-sonnet-5'),
                 system: [persona+rules, CACHED spot digest, volatile itinerary],
                 tools: update_itinerary / get_travel_times  (no execute) })
                 │  SSE stream: text deltas + streaming tool-call parts
                 ▼
        PlannerChat onToolCall:
          · update_itinerary → validate → save (Trip.itinerary or overlay)
                               → addToolOutput({ok, warnings})
          · get_travel_times  → haversine from trip.spots → addToolOutput
                 │  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls
                 ▼
        localStorage change → subscribeLocalTrips → TripView re-renders
                 ▼
        TripMap: day chips · numbered colored markers · polylines
```

The save→render loop means the map updates **the moment the tool call lands**,
mid-conversation — the whiteboard effect falls out of the architecture for free.

## 5. Implementation details

### New files
| File | Contents |
|---|---|
| `lib/itinerary.ts` | Types re-exported to `lib/types.ts`, zod schemas (`ItinerarySchema`), `validateItinerary(input, spots)` → `{itinerary, warnings}`, `getItinerary(trip)` / `saveItinerary(trip, isLocal, itin)` (overlay logic), `haversineKm`, `nearestNeighborsDigest(spots)`, day color palette. |
| `app/api/trips/[id]/chat/route.ts` | `POST` handler: rate-limit (`lib/ratelimit.ts`), build system messages, `streamText` with tool *schemas only*, `createUIMessageStreamResponse`, PostHog capture in `onFinish`. `runtime: nodejs`, `maxDuration: 60`. |
| `components/PlannerChat.tsx` | `useChat` + `DefaultChatTransport` (body carries context), message rendering (`text` + `tool-update_itinerary` summary card + `tool-get_travel_times` chip), `onToolCall` handlers, input box, quick-start hint chips. |

### Modified files
| File | Change |
|---|---|
| `lib/types.ts` | `Trip.itinerary?: Itinerary` + new interfaces. |
| `components/TripView.tsx` | Chat panel toggle ("✨ Plan" button in filter bar), `planOpen` + `activeDay` state, pass itinerary + day selection to `TripMap`, `trip-body` gets a `plan-open` class (grid drops to 2 cols). |
| `components/TripMap.tsx` | New props `itinerary?`, `activeDay?` (`'all' | number | 'unassigned'`), `onDayChange`. Renders: day chip bar (Leaflet-independent overlay div), numbered circular markers in day color for planned stops, dashed polyline per visible day in day order, dimmed pills for unplanned spots when a day filter is active. Stay marker (🏠) when set. |
| `app/globals.css` | Panel layout, chat styles, day chips, numbered pins, polyline-adjacent styles. |

### System prompt sketch (route.ts)

1. **Persona + rules** (static, cacheable): local-guide voice; propose-don't-
   interrogate; ≤2 questions before first draft; respect known `query` data; use
   `update_itinerary` for every plan change (never describe a plan only in prose);
   meals anchor days; realistic travel times; cite spot names exactly.
2. **Spot digest** (static per trip, `cacheControl: ephemeral`): one line per spot —
   `id | name | category | 2-line desc | mentions count | nearest: id(km), id(km), id(km)`
   plus trip meta (destination, dates, interests from `query`).
3. **Volatile tail** (not cached): current itinerary JSON (or "none yet"), today's
   date.

### Tool schemas (zod, shared client/server via `lib/itinerary.ts`)

```ts
update_itinerary: { days: [{ label, date?, theme?, stops: [{ spotId, slot?, note? }] }],
                    stay?: { name, lat?, lng?, note? }, pace?, budget? }
   → client returns { ok: true, warnings: string[], unassignedCount: number }

get_travel_times: { pairs: [{ from: spotId, to: spotId }] }   (≤ 20 pairs)
   → client returns [{ from, to, km, walkMin, driveMin }]
```

## 6. Scope

**v1 (this build)**
- Itinerary model + validation + persistence (local trip field / sample-trip overlay)
- Chat route + panel, streaming, both tools, prompt caching, PostHog capture
- Map: day chips, numbered day-colored markers, per-day polylines, unassigned filter,
  stay pin
- Layout: 3-panel with collapsible chat; cards 3→2 cols

**v2**
- Google Routes API travel times (lazy, adjacent-pairs only) + opening hours from
  Places (`placeId` already on spots)
- "By day" grouping toggle in the cards column; drag spot between days (manual
  override the agent must respect); `locked` stops
- Stay-neighborhood recommendation mode (cluster centroid + candidate-area pins)

**v3**
- BYOK: settings modal, key in localStorage, `x-user-api-key` header →
  `createAnthropic({apiKey})` per request; ship to friends
- Hour-level scheduling; weather-aware replans; itinerary export/share

**Explicitly out of scope**
- Proposal/accept diffs (agent edits directly; day chips make changes visible)
- Server-side itinerary storage, auth/accounts, LangGraph-style orchestration

## 7. Risks / notes

- **AI SDK v7 is new** — patterns verified against the installed package's bundled
  docs (`node_modules/ai/docs`), not memory. Key shapes: `createUIMessageStreamResponse`
  + `toUIMessageStream`, `onToolCall`/`addToolOutput` (don't `await` it),
  `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`, tool parts
  `tool-<name>` with `input-streaming → input-available → output-available` states.
- **Nonstandard Next.js 16** (see AGENTS.md) — route handlers mirror the existing
  `app/api/trips/[id]/route.ts` conventions (`params: Promise<…>`, `runtime` export).
- **Client-validated tool results**: the model may reference stale/unknown spot ids;
  validation returns warnings in the tool result so the model self-corrects in the
  same turn.
- **Sample trips on deployed Vercel**: chat works, plan persists only in that
  browser (overlay). Acceptable for v1.
- **Rate limiting**: reuse `lib/ratelimit.ts` (per-IP) on the chat route to protect
  the shared server key until BYOK lands.
