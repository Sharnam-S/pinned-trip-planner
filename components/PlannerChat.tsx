"use client";

/**
 * The planner agent's chat panel. Stateless server: every request carries the
 * trip context; both tools execute HERE (the browser owns the trip data) —
 * update_itinerary validates + saves to localStorage and the map re-renders
 * mid-conversation, which is what makes the map feel like the agent's
 * whiteboard.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { Itinerary, Trip } from "@/lib/types";
import {
  ItineraryInput,
  TravelTimesInput,
  buildPlannerContext,
  haversineKm,
  saveItinerary,
  travelEstimate,
  validateItinerary,
} from "@/lib/itinerary";

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
  chatSessionId: string;
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

/** Chat text with **bold** rendered (the model writes light markdown). */
function FormattedText({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}
    </>
  );
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
        chatSessionId: ctxRef.current.chatSessionId,
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
  onClose,
}: {
  trip: Trip;
  isLocal: boolean;
  itinerary: Itinerary | null;
  mustSeeIds: string[];
  onItineraryChange: (itin: Itinerary) => void;
  onClose: () => void;
}) {
  const initialMessages = useMemo(() => loadChat(trip.id), [trip.id]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The transport is created once; the ctx ref keeps the request body current.
  const ctxRef = useRef<PlannerCtx>({
    trip,
    itinerary,
    mustSeeIds,
    chatSessionId: crypto.randomUUID(),
  });
  useEffect(() => {
    ctxRef.current.trip = trip;
    ctxRef.current.itinerary = itinerary;
    ctxRef.current.mustSeeIds = mustSeeIds;
  }, [trip, itinerary, mustSeeIds]);

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

  // Grow with the content (up to ~5 lines), like any modern chat input.
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  return (
    <aside className="planner-panel" onClick={(e) => e.stopPropagation()}>
      <div className="planner-head">
        <div className="planner-title">
          <span aria-hidden="true">✨</span> Local planner
        </div>
        <button
          className="close"
          onClick={onClose}
          title="Minimize — your conversation is saved"
          aria-label="Minimize planner"
        >
          ✕
        </button>
      </div>

      <div className="planner-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="planner-intro">
            <p>
              {`I know these ${trip.spots.length} spots well — tell me how many days you have and I'll sketch a day-by-day plan on the map.`}
            </p>
            <div className="planner-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

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
                    <div key={i} className="pm-tool done">
                      🗺️ Updated your plan — {days.length} day
                      {days.length === 1 ? "" : "s"}, {stops} stop
                      {stops === 1 ? "" : "s"}. See the day filters on the map.
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

      {mustSeeIds.length > 0 && (
        <div className="planner-mustsee-bar">
          <span>
            ⭐ {mustSeeIds.length} must-see{mustSeeIds.length === 1 ? "" : "s"}{" "}
            starred
          </span>
          <button
            disabled={busy}
            onClick={() =>
              send(
                `I've starred ${mustSeeIds.length} must-see spot${
                  mustSeeIds.length === 1 ? "" : "s"
                } on the map — make sure every one of them is in the plan.`
              )
            }
          >
            Fit them into my plan
          </button>
        </div>
      )}

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
        <button type="submit" disabled={!input.trim() || busy} aria-label="Send">
          ↑
        </button>
      </form>
    </aside>
  );
}
