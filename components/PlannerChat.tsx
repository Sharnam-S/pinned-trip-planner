"use client";

/**
 * The planner agent's chat panel. Stateless server: every request carries the
 * trip context; both tools execute HERE (the browser owns the trip data) —
 * update_itinerary validates + saves to localStorage and the map re-renders
 * mid-conversation, which is what makes the map feel like the agent's
 * whiteboard.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { Itinerary, Trip } from "@/lib/types";
import { listLocalTrips, readOwnedIds } from "@/lib/clientStore";
import { spotCoverUrl } from "@/lib/photoUrl";
import {
  AskQuestionsInput,
  FindSpotsInput,
  ItineraryInput,
  TravelTimesInput,
  buildPlannerContext,
  haversineKm,
  saveItinerary,
  travelEstimate,
  validateItinerary,
} from "@/lib/itinerary";
import { findSpots } from "@/lib/findSpots";

type PlannerQuestion = {
  id: string;
  prompt: string;
  options: string[];
  multiSelect?: boolean;
  allowOther?: boolean;
};

type QuestionAnswer = { id: string; prompt: string; answer: string };

/** Tap-through question form: one question at a time (series), answers collected
 *  locally, submitted in one shot. Shared by the instant intake card and the
 *  agent's ask_questions tool — the parent decides what onSubmit does. */
function QuestionFlow({
  questions,
  submitLabel,
  onSubmit,
}: {
  questions: PlannerQuestion[];
  submitLabel: string;
  onSubmit: (answers: QuestionAnswer[]) => void;
}) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const compile = (): QuestionAnswer[] =>
    questions.map((q) => {
      const chosen = picks[q.id] ?? [];
      const typed = (other[q.id] ?? "").trim();
      const answer = [...chosen, ...(typed ? [typed] : [])].join(", ");
      return { id: q.id, prompt: q.prompt, answer: answer || "no preference" };
    });

  if (done) {
    return (
      <div className="pm-qa done">
        {compile().map((a) => (
          <div key={a.id} className="pm-qa-answered">
            <span className="pm-qa-q">{a.prompt}</span>
            <span className="pm-qa-a">{a.answer}</span>
          </div>
        ))}
      </div>
    );
  }

  const q = questions[step];
  const chosen = picks[q.id] ?? [];
  const typed = other[q.id] ?? "";
  const isLast = step === questions.length - 1;

  function toggle(opt: string) {
    setPicks((prev) => {
      const cur = prev[q.id] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.id]: cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt],
        };
      }
      return { ...prev, [q.id]: cur.includes(opt) ? [] : [opt] };
    });
  }

  function advance() {
    if (isLast) {
      setDone(true);
      onSubmit(compile());
    } else {
      setStep((s) => s + 1);
    }
  }

  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  return (
    <div className="pm-qa">
      <div className="pm-qa-progress">
        {step + 1} of {questions.length}
      </div>
      <div className="pm-qa-prompt">{q.prompt}</div>
      {q.options.length > 0 && (
        <div className="pm-qa-options">
          {q.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={`pm-qa-chip${chosen.includes(opt) ? " on" : ""}`}
              onClick={() => toggle(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {q.allowOther && (
        <input
          className="pm-qa-other"
          placeholder="Something else…"
          value={typed}
          onChange={(e) =>
            setOther((prev) => ({ ...prev, [q.id]: e.target.value }))
          }
        />
      )}
      <div className="pm-qa-nav">
        <button
          type="button"
          className="pm-qa-arrow"
          onClick={back}
          disabled={step === 0}
          aria-label="Previous question"
        >
          ←
        </button>
        {isLast ? (
          <button type="button" className="pm-qa-next" onClick={advance}>
            {submitLabel}
          </button>
        ) : (
          <button
            type="button"
            className="pm-qa-arrow next"
            onClick={advance}
            aria-label="Next question"
          >
            →
          </button>
        )}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "Plan my days for me",
  "Where should I stay?",
  "We're on a budget — keep it affordable",
];

// Staged cues while the model thinks (thinking isn't streamed, so without
// this the panel sits on silent dots for tens of seconds and looks stuck).
const THINKING_CUES: [afterSec: number, cue: string][] = [
  [0, "Thinking…"],
  [6, "Reading your spots and clustering neighborhoods…"],
  [15, "Drafting the day-by-day plan…"],
  [35, "Big plans take a little while — still working…"],
  [75, "Almost there — finalizing the days…"],
];

/** Typing indicator with an elapsed-seconds counter and staged status cues. */
function ThinkingStatus() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const cue = [...THINKING_CUES].reverse().find(([after]) => elapsed >= after)![1];
  return (
    <div className="pm pm-assistant">
      <div className="pm-typing">
        <span /><span /><span />
      </div>
      <div className="pm-status">
        {cue}
        {elapsed >= 6 && <span className="pm-elapsed"> {elapsed}s</span>}
      </div>
    </div>
  );
}

interface PlannerCtx {
  trip: Trip;
  itinerary: Itinerary | null;
  mustSeeIds: string[];
  // One PostHog trace = one sitting. Minted per component mount, so a page
  // reload starts a fresh trace; group across sittings by tripId (one chat
  // per trip). See docs/agentic-planner.md §5.5.
  traceId: string;
}

// --- Chat history: per-trip, in localStorage (same as plans and stars —
// nothing user-specific ever lives on the server) ---

const CHAT_PREFIX = "pinned.chat.";
const CHAT_MAX_MESSAGES = 80;

/** A refresh mid-turn can leave the last assistant message with a tool call
 *  that never got its output — replaying that to the API is invalid, so drop
 *  trailing messages until the conversation ends on solid ground. */
function sanitizeChat(messages: UIMessage[]): UIMessage[] {
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1];
    const dangling =
      last.role === "assistant" &&
      last.parts.some(
        (p) =>
          p.type.startsWith("tool-") &&
          "state" in p &&
          p.state !== "output-available" &&
          p.state !== "output-error"
      );
    if (!dangling) break;
    out.pop();
  }
  return out;
}

function loadChat(tripId: string): UIMessage[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(CHAT_PREFIX + tripId);
    return raw ? sanitizeChat(JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function saveChat(tripId: string, messages: UIMessage[]): void {
  try {
    localStorage.setItem(
      CHAT_PREFIX + tripId,
      JSON.stringify(messages.slice(-CHAT_MAX_MESSAGES))
    );
  } catch {
    // quota exceeded — this session still works from memory
  }
}

/** How much history rides along on each request. Older turns are dropped —
 *  the durable planning state (itinerary, stars, budget, pace) travels in
 *  the context block every turn, so truncation doesn't lose the plan. */
const SEND_WINDOW = 30;

function windowMessages(messages: UIMessage[]): UIMessage[] {
  let out = messages.slice(-SEND_WINDOW);
  // The window must open on a user turn (a leading assistant message would
  // replay tool calls with no preceding request).
  while (out.length > 0 && out[0].role !== "user") out = out.slice(1);
  return out.length > 0 ? out : messages.slice(-1);
}

/** Inline formatting within a line: **bold** → <strong>. */
function inline(text: string): ReactNode[] {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p));
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Renders the model's light markdown as real blocks so replies read like a
 * chat, not one wall of text: blank lines separate paragraphs, and runs of
 * "- "/"1. " lines become <ul>/<ol>. The vertical rhythm is what gives the
 * panel its breathing space — a full markdown library isn't worth the weight
 * for the handful of constructs the persona actually writes.
 */
function FormattedText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const lines = para;
    blocks.push(
      <p key={blocks.length}>
        {lines.map((l, i) => (
          <span key={i}>
            {i > 0 && <br />}
            {inline(l)}
          </span>
        ))}
      </p>
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    const children = items.map((it, i) => <li key={i}>{inline(it)}</li>);
    blocks.push(
      ordered ? (
        <ol key={blocks.length}>{children}</ol>
      ) : (
        <ul key={blocks.length}>{children}</ul>
      )
    );
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const bullet = line.match(BULLET_RE);
    const numbered = bullet ? null : line.match(NUMBERED_RE);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <>{blocks}</>;
}

// Module scope so the request-time callback reads the ref outside render
// (react-hooks/refs). The transport is created once per trip; the ref always
// holds the latest trip + itinerary when a request actually fires.
function makeTransport(tripId: string, ctxRef: { current: PlannerCtx }) {
  return new DefaultChatTransport({
    api: `/api/trips/${tripId}/chat`,
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        messages: windowMessages(messages),
        context: buildPlannerContext(
          ctxRef.current.trip,
          ctxRef.current.itinerary,
          ctxRef.current.mustSeeIds
        ),
        traceId: ctxRef.current.traceId,
      },
    }),
  });
}

/** One trip has ONE conversation — it lives in localStorage and survives
 *  minimize, refresh, and coming back days later. */
export default function PlannerChat({
  trip,
  isLocal,
  itinerary,
  mustSeeIds,
  onItineraryChange,
}: {
  trip: Trip;
  isLocal: boolean;
  itinerary: Itinerary | null;
  mustSeeIds: string[];
  onItineraryChange: (itin: Itinerary) => void;
}) {
  const initialMessages = useMemo(() => loadChat(trip.id), [trip.id]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Visitors who haven't built a trip of their own only ever see this panel on
  // a sample trip — greet them with a create-your-first-trip nudge instead of
  // the planning intro. "Test-drive" dismisses it for this page view.
  const [hasOwnTrips] = useState(
    () => listLocalTrips().length > 0 || readOwnedIds().length > 0
  );
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  // The three best-loved spots' photos, fanned like a hand of postcards. Best
  // photo front and center; a card whose photo fails to load hides itself.
  const nudgePhotos = useMemo(() => {
    if (hasOwnTrips) return [];
    const urls = [...trip.spots]
      .sort((a, b) => b.mentions.length - a.mentions.length)
      .map((s) => spotCoverUrl(s))
      .filter((u): u is string => Boolean(u))
      .slice(0, 3);
    const [front, left, right] = urls;
    return [
      ...(left ? [{ url: left, cls: "left" }] : []),
      ...(right ? [{ url: right, cls: "right" }] : []),
      ...(front ? [{ url: front, cls: "front" }] : []),
    ];
  }, [trip, hasOwnTrips]);

  // The transport is created once; the ctx ref keeps the request body current.
  const ctxRef = useRef<PlannerCtx>({
    trip,
    itinerary,
    mustSeeIds,
    traceId: crypto.randomUUID(),
  });
  useEffect(() => {
    ctxRef.current.trip = trip;
    ctxRef.current.itinerary = itinerary;
    ctxRef.current.mustSeeIds = mustSeeIds;
  }, [trip, itinerary, mustSeeIds]);

  // Starred must-sees that the agent hasn't placed in the plan yet. The bar
  // nudges the user to fit these in, so it should hide once they're all
  // planned — even though the spots stay starred in the location pane.
  const unplannedMustSeeIds = useMemo(() => {
    const planned = new Set(
      (itinerary?.days ?? []).flatMap((d) => d.stops.map((s) => s.spotId))
    );
    return mustSeeIds.filter((id) => !planned.has(id));
  }, [itinerary, mustSeeIds]);

  // Instant intake — a few universal questions rendered client-side (no model
  // round-trip). Answers compile into the first message; the agent then
  // proposes the rough shape (route persona §PLAN IN TWO STEPS). Dates only if
  // the trip has none set.
  const intakeQuestions = useMemo<PlannerQuestion[]>(() => {
    const iconic = [...trip.spots]
      .sort((a, b) => b.mentions.length - a.mentions.length)
      .slice(0, 3)
      .map((s) => s.name);
    const hasDates = Boolean(trip.query?.startDate && trip.query?.endDate);
    return [
      { id: "who", prompt: "Who's going?", options: ["Solo", "Couple", "Family", "Friends"], allowOther: true },
      { id: "pace", prompt: "How packed should it be?", options: ["Relaxed", "Balanced", "Packed"], allowOther: true },
      ...(iconic.length
        ? [{ id: "mustsee", prompt: "Anything you must include?", options: iconic, multiSelect: true, allowOther: true }]
        : []),
      { id: "budget", prompt: "Budget vibe?", options: ["Backpacker", "Mid-range", "Splurge"] },
      ...(!hasDates
        ? [{ id: "dates", prompt: "Rough dates? (a month is fine)", options: [], allowOther: true }]
        : []),
    ];
  }, [trip]);

  // find_spots (agent tool): live status per tool call, plus guards against
  // re-fetching or spamming the slow, quota-costing YouTube discovery.
  const [findProgress, setFindProgress] = useState<Record<string, string>>({});
  const findCache = useRef<Set<string>>(new Set());
  const findCount = useRef(0);

  // The transport only reads the ref at request time
  // (prepareSendMessagesRequest), never during render.
  // eslint-disable-next-line react-hooks/refs
  const transport = useMemo(() => makeTransport(trip.id, ctxRef), [trip.id]);

  const { messages, sendMessage, addToolOutput, status, error, regenerate } = useChat({
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;

      if (toolCall.toolName === "update_itinerary") {
        const currentTrip = ctxRef.current.trip;
        const { itinerary: next, warnings } = validateItinerary(
          toolCall.input as ItineraryInput,
          currentTrip.spots
        );
        saveItinerary(currentTrip.id, isLocal, next);
        onItineraryChange(next);
        const planned = next.days.reduce((n, d) => n + d.stops.length, 0);
        addToolOutput({
          tool: "update_itinerary",
          toolCallId: toolCall.toolCallId,
          output: {
            ok: true,
            warnings,
            plannedStops: planned,
            unassignedCount: currentTrip.spots.length - planned,
          },
        });
      } else if (toolCall.toolName === "get_travel_times") {
        const spots = new Map(ctxRef.current.trip.spots.map((s) => [s.id, s]));
        const { pairs } = toolCall.input as TravelTimesInput;
        const results = pairs.map(({ from, to }) => {
          const a = spots.get(from);
          const b = spots.get(to);
          if (!a || !b) return { from, to, error: "unknown spot id" };
          const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
          return { from, to, km: Number(km.toFixed(2)), ...travelEstimate(km) };
        });
        addToolOutput({
          tool: "get_travel_times",
          toolCallId: toolCall.toolCallId,
          output: results,
        });
      } else if (toolCall.toolName === "find_spots") {
        const { area, interest } = toolCall.input as FindSpotsInput;
        const id = toolCall.toolCallId;
        const reply = (output: unknown) =>
          addToolOutput({ tool: "find_spots", toolCallId: id, output });
        if (!isLocal) {
          reply({
            ok: false,
            message:
              "Finding new spots only works on your own trips, not this sample.",
          });
          return;
        }
        const key = `${area ?? ""}|${interest ?? ""}`.trim().toLowerCase();
        if (key && findCache.current.has(key)) {
          reply({
            ok: false,
            message: "Already pulled fresh spots for that — they're on the map.",
          });
          return;
        }
        if (findCount.current >= 3) {
          reply({
            ok: false,
            message:
              "Reached the limit for fetching new spots this session — plan with what's on the map.",
          });
          return;
        }
        findCount.current += 1;
        if (key) findCache.current.add(key);
        const t = ctxRef.current.trip;
        const dest =
          t.destination?.name ??
          t.query?.resolvedDestination ??
          t.query?.destination ??
          "";
        try {
          const res = await findSpots(
            t.id,
            { destination: area ? `${area}, ${dest}` : dest, interests: interest },
            (msg) => setFindProgress((p) => ({ ...p, [id]: msg }))
          );
          reply(
            res.added > 0
              ? {
                  ok: true,
                  added: res.added,
                  spots: res.spots,
                  message: `Added ${res.added} spot${
                    res.added === 1 ? "" : "s"
                  }${area ? ` around ${area}` : ""}.`,
                }
              : {
                  ok: false,
                  message: `Couldn't find good new spots${
                    area ? ` for ${area}` : ""
                  } — want me to plan with what's on the map?`,
                }
          );
        } catch {
          // Let the model retry a hard failure — don't cache the miss.
          if (key) findCache.current.delete(key);
          reply({
            ok: false,
            message:
              "That spot search hit a snag — let's plan with existing spots, or try again.",
          });
        }
      }
    },
  });

  const busy = status === "submitted" || status === "streaming";

  // The stream can die server-side without an error event (e.g. a runtime
  // timeout kills the function mid-think) — the request "finishes" but the
  // last turn produced no assistant output. Detect it and offer a retry.
  const last = messages[messages.length - 1];
  const lastAssistantEmpty =
    last?.role === "assistant" &&
    !last.parts.some(
      (p) =>
        (p.type === "text" && p.text.trim()) || p.type.startsWith("tool-")
    );
  const streamDropped =
    !busy && !error && (last?.role === "user" || lastAssistantEmpty);

  useEffect(() => {
    // Follow the conversation as it streams.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, error, streamDropped]);

  // Persist continuously (debounced against streaming churn) AND flush on
  // unmount — closing the panel mid-turn must never lose the conversation.
  // The load-time sanitizer handles any half-finished turn this captures.
  const messagesRef = useRef(initialMessages);
  useEffect(() => {
    messagesRef.current = messages;
    if (messages.length === 0) return;
    const t = setTimeout(() => saveChat(trip.id, messages), 400);
    return () => clearTimeout(t);
  }, [messages, trip.id]);
  useEffect(() => {
    return () => {
      if (messagesRef.current.length > 0) saveChat(trip.id, messagesRef.current);
    };
  }, [trip.id]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
    const el = inputRef.current;
    if (el) el.style.height = "auto";
  }

  // Instant intake answers → one compiled first message. The agent (persona)
  // then proposes the rough shape rather than a full pin plan.
  function submitIntake(answers: QuestionAnswer[]) {
    const stated = answers.filter(
      (a) => a.answer && a.answer !== "no preference"
    );
    send(
      stated.length
        ? `Here's my trip:\n${stated
            .map((a) => `- ${a.prompt} ${a.answer}`)
            .join("\n")}\n\nPlan my days.`
        : "Plan my days for me."
    );
  }

  // Grow with the content (up to ~5 lines), like any modern chat input.
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  const showNudge = !hasOwnTrips && !isLocal && !nudgeDismissed;
  // While the instant intake form is up it's the single call-to-action — hide
  // the free-text input so the user isn't facing two competing inputs.
  const intakeActive = messages.length === 0 && !showNudge && !itinerary;

  return (
    <aside className="planner-panel" onClick={(e) => e.stopPropagation()}>
      <div className="planner-scroll" ref={scrollRef}>
        {messages.length === 0 &&
          (showNudge ? (
            <div className="planner-nudge">
              {nudgePhotos.length > 0 && (
                <div className="nudge-stack" aria-hidden="true">
                  {nudgePhotos.map(({ url, cls }) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={url}
                      className={`nudge-card ${cls}`}
                      src={url}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  ))}
                </div>
              )}
              <h3 className="nudge-title">
                Where are <em>you</em> headed?
              </h3>
              <p className="nudge-sub">
                {`You're browsing a sample trip. Create your own and we'll map every spot creators rave about — then I'll plan your days around them.`}
              </p>
              <Link className="nudge-cta" href="/?start=1">
                Create your first trip
              </Link>
              <button
                className="nudge-alt"
                onClick={() => setNudgeDismissed(true)}
              >
                or test-drive me on this sample →
              </button>
            </div>
          ) : !itinerary ? (
            <div className="pm pm-assistant pm-intake">
              <div className="pm-text">
                <p>
                  {`I know these ${trip.spots.length} spots inside out. Tell me a few quick things and I'll sketch your days.`}
                </p>
              </div>
              <QuestionFlow
                questions={intakeQuestions}
                submitLabel="Plan my trip →"
                onSubmit={submitIntake}
              />
            </div>
          ) : (
            <div className="planner-intro">
              <p>
                {`I know these ${trip.spots.length} spots well — tell me what to tweak and I'll update the plan on the map.`}
              </p>
              <div className="planner-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion-chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}

        {messages.map((message) => (
          <div key={message.id} className={`pm pm-${message.role}`}>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <div key={i} className="pm-text">
                    <FormattedText text={part.text} />
                  </div>
                );
              }
              if (part.type === "reasoning") {
                if (!part.text.trim()) return null;
                // Live while thinking; collapses to a toggle once done.
                return part.state === "streaming" ? (
                  <div key={i} className="pm-reasoning streaming">
                    <div className="pm-reasoning-label">💭 Thinking…</div>
                    <div className="pm-reasoning-text">{part.text}</div>
                  </div>
                ) : (
                  <details key={i} className="pm-reasoning">
                    <summary className="pm-reasoning-label">
                      💭 Thought it through
                    </summary>
                    <div className="pm-reasoning-text">{part.text}</div>
                  </details>
                );
              }
              if (part.type === "tool-update_itinerary") {
                if (
                  part.state === "input-streaming" ||
                  part.state === "input-available"
                ) {
                  return (
                    <div key={i} className="pm-tool working">
                      🗺️ Sketching the plan on your map…
                    </div>
                  );
                }
                if (part.state === "output-available") {
                  const input = part.input as ItineraryInput;
                  const days = input?.days ?? [];
                  const stops = days.reduce((n, d) => n + (d.stops?.length ?? 0), 0);
                  return (
                    <div key={i} className="pm-event">
                      <span className="pm-event-icon" aria-hidden="true">
                        ✓
                      </span>
                      <div className="pm-event-body">
                        <div className="pm-event-title">Plan updated</div>
                        <div className="pm-event-meta">
                          {days.length} day{days.length === 1 ? "" : "s"} ·{" "}
                          {stops} stop{stops === 1 ? "" : "s"} · see the day
                          filters on the map
                        </div>
                      </div>
                    </div>
                  );
                }
                if (part.state === "output-error") {
                  return (
                    <div key={i} className="pm-tool error">
                      Couldn&rsquo;t apply the plan: {part.errorText}
                    </div>
                  );
                }
                return null;
              }
              if (part.type === "tool-get_travel_times") {
                return part.state === "output-available" ? (
                  <div key={i} className="pm-tool done">
                    📏 Checked travel times
                  </div>
                ) : (
                  <div key={i} className="pm-tool working">
                    📏 Checking travel times…
                  </div>
                );
              }
              if (part.type === "tool-ask_questions") {
                if (part.state === "output-available") {
                  const answers = part.output as QuestionAnswer[] | undefined;
                  return (
                    <div key={i} className="pm-qa done">
                      {(answers ?? []).map((a) => (
                        <div key={a.id} className="pm-qa-answered">
                          <span className="pm-qa-q">{a.prompt}</span>
                          <span className="pm-qa-a">{a.answer}</span>
                        </div>
                      ))}
                    </div>
                  );
                }
                if (part.state === "input-available") {
                  const qs =
                    (part.input as AskQuestionsInput | undefined)?.questions ??
                    [];
                  if (qs.length === 0) return null;
                  return (
                    <QuestionFlow
                      key={i}
                      questions={qs}
                      submitLabel="Send answers →"
                      onSubmit={(answers) =>
                        addToolOutput({
                          tool: "ask_questions",
                          toolCallId: part.toolCallId,
                          output: answers,
                        })
                      }
                    />
                  );
                }
                return (
                  <div key={i} className="pm-tool working">
                    ✍️ Preparing a few quick questions…
                  </div>
                );
              }
              if (part.type === "tool-find_spots") {
                if (part.state === "output-available") {
                  const out = part.output as
                    | { ok?: boolean; added?: number; message?: string }
                    | undefined;
                  return out?.ok ? (
                    <div key={i} className="pm-event">
                      <span className="pm-event-icon" aria-hidden="true">
                        ✓
                      </span>
                      <div className="pm-event-body">
                        <div className="pm-event-title">
                          Added {out.added} new spot
                          {out.added === 1 ? "" : "s"}
                        </div>
                        <div className="pm-event-meta">now on your map</div>
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="pm-tool">
                      🔎 {out?.message ?? "No new spots found"}
                    </div>
                  );
                }
                if (part.state === "output-error") {
                  return (
                    <div key={i} className="pm-tool error">
                      Spot search failed
                    </div>
                  );
                }
                return (
                  <div key={i} className="pm-tool working">
                    🔎 {findProgress[part.toolCallId] ?? "Finding more spots…"}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}

        {busy && <ThinkingStatus />}
        {error && (
          <div className="pm-problem">
            <div>Something went wrong: {error.message}</div>
            <button className="pm-retry" onClick={() => regenerate()}>
              ↻ Try again
            </button>
          </div>
        )}
        {streamDropped && (
          <div className="pm-problem">
            <div>
              The connection dropped before the plan arrived — this can happen
              on very large plans.
            </div>
            <button className="pm-retry" onClick={() => regenerate()}>
              ↻ Try again
            </button>
          </div>
        )}
      </div>

      {unplannedMustSeeIds.length > 0 && (
        <div className="planner-mustsee-bar">
          <span>
            ⭐ {unplannedMustSeeIds.length} must-see
            {unplannedMustSeeIds.length === 1 ? "" : "s"} not in your plan yet
          </span>
          <button
            disabled={busy}
            onClick={() =>
              send(
                `I've starred ${unplannedMustSeeIds.length} must-see spot${
                  unplannedMustSeeIds.length === 1 ? "" : "s"
                } on the map that aren't in the plan yet — make sure every one of them is included.`
              )
            }
          >
            Fit them into my plan
          </button>
        </div>
      )}

      {!intakeActive && (
        <form
          className="planner-inputrow"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask your local planner…"
            aria-label="Message the planner"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            aria-label="Send"
          >
            ↑
          </button>
        </form>
      )}
    </aside>
  );
}
