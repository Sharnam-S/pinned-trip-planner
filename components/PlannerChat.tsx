"use client";

/**
 * The planner agent's chat panel. Stateless server: every request carries the
 * trip context; both tools execute HERE (the browser owns the trip data) —
 * update_itinerary validates + saves to localStorage and the map re-renders
 * mid-conversation, which is what makes the map feel like the agent's
 * whiteboard.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { Itinerary, Spot, SpotCategory, Trip } from "@/lib/types";
import { listLocalTrips, readOwnedIds } from "@/lib/clientStore";
import { fetchServerChat, noteChatFromServer, pushChat } from "@/lib/sync";
import { tripStoreMode } from "@/lib/tripStore";
import { spotCoverUrl } from "@/lib/photoUrl";
import {
  AskQuestionsInput,
  DiscardPlanInput,
  FindSpotsInput,
  ItineraryInput,
  LoadPlanInput,
  MAX_PLANS,
  TravelTimesInput,
  activePlan,
  buildPlannerContext,
  discardPlan,
  haversineKm,
  travelEstimate,
  applyPlanUpdate,
  markPlanDeferred,
  planWasDeferred,
  clearPlanDeferred,
  DAY_STRUCTURE_RE,
} from "@/lib/itinerary";
import { buildProgress } from "@/lib/merge";
import { findSpots } from "@/lib/findSpots";
import { track } from "@/lib/track";

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
  answerRef,
  onSubmit,
}: {
  questions: PlannerQuestion[];
  submitLabel: string;
  /** Filled with "answer the current question in words", so typing in the main
   *  composer answers the card instead of stranding it — see answerWithText. */
  answerRef?: React.MutableRefObject<((text: string) => void) | null>;
  onSubmit: (answers: QuestionAnswer[]) => void;
}) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  // `otherOverride` exists because answering by typing sets state and submits in
  // the same tick — compile() would otherwise read the pre-update map.
  const compile = (
    otherOverride?: Record<string, string>
  ): QuestionAnswer[] => {
    const typedMap = otherOverride ?? other;
    return questions.map((q) => {
      const chosen = picks[q.id] ?? [];
      const typed = (typedMap[q.id] ?? "").trim();
      const answer = [...chosen, ...(typed ? [typed] : [])].join(", ");
      return { id: q.id, prompt: q.prompt, answer: answer || "no preference" };
    });
  };

  const q = questions[step];
  const isLast = step === questions.length - 1;

  // Hand the parent a "answer in words" callback while this card is open, so a
  // traveler who types instead of tapping answers the question rather than
  // stranding it. Re-registered every render so it closes over current state,
  // and declared BEFORE the `done` early return to keep hook order stable.
  useEffect(() => {
    if (!answerRef) return;
    answerRef.current = done ? null : answerWithText;
    return () => {
      answerRef.current = null;
    };
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

  const chosen = picks[q.id] ?? [];
  const typed = other[q.id] ?? "";

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

  /** The traveler typed in the main composer while this card was open. Treat it
   *  as the current question's answer and move on — the alternative (letting the
   *  message through) leaves this tool call with no result, which makes every
   *  later request an invalid conversation the user cannot recover from. */
  function answerWithText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const nextOther = { ...other, [q.id]: trimmed };
    setOther(nextOther);
    if (isLast) {
      setDone(true);
      onSubmit(compile(nextOther));
    } else {
      setStep((s) => s + 1);
    }
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

/** Phone intake (Z2-b): the same questions as QuestionFlow, asked one at a
 *  time as a scripted conversation — each tap becomes a "user message", the
 *  next question streams in as the reply. Entirely client-side; the LLM is
 *  called once, with the compiled answers (via onSubmit → submitIntake).
 *  Typing in the main composer answers the current question too — the
 *  parent routes it here through answerRef. */
function ConversationalIntake({
  title,
  photos,
  questions,
  answerRef,
  onSubmit,
}: {
  title: string;
  photos: string[];
  questions: PlannerQuestion[];
  answerRef: React.MutableRefObject<((text: string) => void) | null>;
  onSubmit: (answers: QuestionAnswer[]) => void;
}) {
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
  const [picks, setPicks] = useState<string[]>([]); // current multi-select
  const endRef = useRef<HTMLDivElement>(null);

  const step = answers.length;
  const q: PlannerQuestion | undefined = questions[step];

  const answer = (text: string) => {
    if (!q) return;
    const next = [
      ...answers,
      { id: q.id, prompt: q.prompt, answer: text.trim() || "no preference" },
    ];
    setAnswers(next);
    setPicks([]);
    if (next.length === questions.length) onSubmit(next);
  };

  // The parent's composer answers the current question while intake runs.
  useEffect(() => {
    answerRef.current = answer;
    return () => {
      answerRef.current = null;
    };
  });

  // New turns appear below the fold in a half-height sheet — follow them.
  useEffect(() => {
    if (step > 0) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [step]);

  return (
    <div className="ci">
      <h3 className="ci-title">{title} ✨</h3>
      {photos.length > 0 && (
        <div className="ci-strip" aria-hidden="true">
          {photos.map((url) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ))}
        </div>
      )}
      {answers.map((a, i) => (
        <div className="ci-turn" key={a.id}>
          <div className="ci-q">{questions[i].prompt}</div>
          <div className="ci-a">{a.answer}</div>
        </div>
      ))}
      {q && (
        <div className="ci-turn">
          <div className="ci-q">{q.prompt}</div>
          <div className="ci-chips">
            {q.options.map((opt) =>
              q.multiSelect ? (
                <button
                  key={opt}
                  className={`suggestion-chip ${picks.includes(opt) ? "on" : ""}`}
                  aria-pressed={picks.includes(opt)}
                  onClick={() =>
                    setPicks((p) =>
                      p.includes(opt) ? p.filter((x) => x !== opt) : [...p, opt]
                    )
                  }
                >
                  {opt}
                </button>
              ) : (
                <button
                  key={opt}
                  className="suggestion-chip"
                  onClick={() => answer(opt)}
                >
                  {opt}
                </button>
              )
            )}
            {q.multiSelect && picks.length > 0 && (
              <button className="ci-done" onClick={() => answer(picks.join(", "))}>
                That&rsquo;s it →
              </button>
            )}
            <button className="ci-skip" onClick={() => answer("")}>
              Skip
            </button>
          </div>
          {(q.allowOther || q.options.length === 0) && (
            <div className="ci-hint">…or type your answer below.</div>
          )}
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

const SUGGESTIONS = [
  "Plan my days for me",
  // Options are the least discoverable thing the agent can do, and the chip is
  // cheaper than explaining them.
  "Build me a different option to compare",
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
  /** Every plan option, oldest first — the agent writes them side by side. */
  plans: Itinerary[];
  /** The option the rail is showing; the agent edits this one unless told
   *  otherwise. */
  activePlanId: string | null;
  mustSeeIds: string[];
  // One PostHog trace = one sitting. Minted per component mount, so a page
  // reload starts a fresh trace; group across sittings by tripId (one chat
  // per trip). See docs/agentic-planner.md §5.5.
  traceId: string;
}

// --- Chat history: per-trip. localStorage is the working copy (fast, offline,
// works signed-out); owned trips additionally sync to the account so the
// conversation follows the user across devices (lib/sync.ts). ---

const CHAT_PREFIX = "pinned.chat.";
const CHAT_MAX_MESSAGES = 80;

/** A turn that was interrupted leaves rubbish at the end of the array: a tool
 *  call with no output (invalid to replay to the API), or an assistant message
 *  that only ever got as far as a reasoning block — a truncated "Thinking…"
 *  paragraph that reads like the planner trailed off mid-sentence, and which
 *  used to make the panel cry "the connection dropped" on a conversation that
 *  had actually finished. Drop trailing messages until the conversation ends on
 *  solid ground. */
function sanitizeChat(messages: UIMessage[]): UIMessage[] {
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.role !== "assistant") break;
    const dangling = last.parts.some(
      (p) =>
        p.type.startsWith("tool-") &&
        "state" in p &&
        p.state !== "output-available" &&
        p.state !== "output-error"
    );
    const nothingSaid = !last.parts.some(
      (p) => (p.type === "text" && p.text.trim()) || p.type.startsWith("tool-")
    );
    if (!dangling && !nothingSaid) break;
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

/** Signed out only: the conversation has nowhere else to live. Signed in, the
 *  account copy (pushChat) is the store — writing it here too would put the
 *  biggest consumer back into a 5M-character budget. */
async function saveChat(tripId: string, messages: UIMessage[]): Promise<void> {
  if ((await tripStoreMode()) === "server") return;
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
  return closeDanglingToolCalls(out.length > 0 ? out : messages.slice(-1));
}

/**
 * A tool call with no result makes the whole conversation invalid — Anthropic
 * rejects a `tool_use` block with no matching `tool_result` — and the failure is
 * permanent, because the offending message is already in stored history. Every
 * later send fails with "Tool result is missing for tool call toolu_…", and
 * "Try again" replays the same broken array.
 *
 * `sanitizeChat` only drops a *trailing* dangling message, which doesn't help
 * once the traveler has said something after it. So close the gap here, at the
 * request boundary: whatever the UI did, what goes on the wire is valid. The
 * synthesized result also tells the model what happened, so it can pick the
 * thread up from the traveler's own words instead of re-asking.
 */
function closeDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    type Part = UIMessage["parts"][number];
    let patched = false;
    const parts = m.parts.map((p): Part => {
      if (
        !p.type.startsWith("tool-") ||
        !("state" in p) ||
        p.state === "output-available" ||
        p.state === "output-error"
      ) {
        return p;
      }
      patched = true;
      // The cast is the honest shape: a tool part carrying a result. TS can't
      // narrow a spread across the part union on its own.
      return {
        ...p,
        state: "output-available",
        output: {
          ok: false,
          error:
            "No result — the traveler replied in the chat instead of using this card. Read their message and carry on.",
        },
      } as Part;
    });
    return patched ? { ...m, parts } : m;
  });
}

/** Inline formatting within a line: **bold** → <strong>. */
function inline(text: string): ReactNode[] {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p));
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^\s*(#{1,4})\s+(.*?)\s*#*$/;
const RULE_RE = /^\s*([-*_])\1{2,}\s*$/;
// The agent names a day's anchor spots and the client turns them into a photo
// strip: `[pins: <id>, <id>]`. Ids are canonical, but a model that writes the
// spot's name instead still gets its picture — see resolvePins.
const PINS_RE = /^\s*\[pins?:\s*([^\]]+)\]\s*$/i;
// The same line half-streamed. Without this the raw directive flashes as text
// for the frames between "[pins: 6543…" and its closing bracket.
const PINS_PARTIAL_RE = /^\s*\[pins?:[^\]]*$/i;
// One proposed base: `[stay: Canggu — 3 nights — near the beach clubs]`.
// Same bracket convention as the pins line, and the same reason for it: the
// agent needs a way to say something structured inside prose without the
// traveler ever seeing the syntax. Consecutive lines collect into one card.
const STAY_RE = /^\s*\[stays?:\s*([^\]]+)\]\s*$/i;
const STAY_PARTIAL_RE = /^\s*\[stays?:[^\]]*$/i;

/** "Canggu — 3 nights — near the beach clubs" → its three parts. Em dash, en
 *  dash or hyphen, because the model uses all three. */
function parseStayLine(body: string): { area: string; nights: string; why: string } {
  const parts = body.split(/\s+[—–-]\s+/);
  return {
    area: (parts[0] ?? "").trim(),
    nights: (parts[1] ?? "").trim(),
    why: parts.slice(2).join(" — ").trim(),
  };
}

/** Spots for a pins directive, in the order named. Ids first (that's what the
 *  context hands the model), names as a forgiving fallback; anything that
 *  matches nothing is dropped rather than rendered as a hole. */
function resolvePins(list: string, spots: Spot[]): Spot[] {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const byName = new Map(spots.map((s) => [s.name.trim().toLowerCase(), s]));
  const out: Spot[] = [];
  for (const raw of list.split(",")) {
    const key = raw.trim();
    if (!key) continue;
    const spot = byId.get(key) ?? byName.get(key.toLowerCase());
    if (spot && !out.includes(spot)) out.push(spot);
  }
  return out;
}

/** The proposed bases, as a card inside the summary document.
 *
 *  This lands BEFORE any pin does, which is the point: how many bases and
 *  where is a decision the traveler has to make before the days mean anything,
 *  and it is far easier to argue with here than after thirty pins have been
 *  placed. Once they accept, the same information is written onto the plan and
 *  rendered in the itinerary rail. */
function StayStrip({ bases }: { bases: { area: string; nights: string; why: string }[] }) {
  if (bases.length === 0) return null;
  return (
    <div className="stay-strip">
      <div className="stay-strip-head">Where to stay</div>
      {bases.map((b, i) => (
        <div className="stay-row" key={`${b.area}-${i}`}>
          <span className="stay-index">{i + 1}</span>
          <div className="stay-body">
            <div className="stay-area">
              {b.area}
              {b.nights ? <span className="stay-nights">{b.nights}</span> : null}
            </div>
            {b.why ? <div className="stay-why">{b.why}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A day's photo strip: the first three of the day's spots, each a way into the
 *  spot itself. A fourth-and-beyond count rides on the last tile so the strip
 *  says how much the day holds without growing. */
function PinStrip({
  spots,
  onSelectSpot,
}: {
  spots: Spot[];
  onSelectSpot?: (id: string) => void;
}) {
  const shown = spots.slice(0, 3);
  const more = spots.length - shown.length;
  const photos = shown.map((s) => ({ spot: s, url: spotCoverUrl(s) }));
  if (photos.every((p) => !p.url)) return null;
  return (
    <div className="pin-strip">
      {photos.map(({ spot, url }, i) =>
        url ? (
          <button
            type="button"
            key={spot.id}
            className="pin-shot"
            title={spot.name}
            aria-label={`Open ${spot.name}`}
            onClick={() => onSelectSpot?.(spot.id)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt=""
              onError={(e) => {
                e.currentTarget.closest("button")?.remove();
              }}
            />
            {more > 0 && i === photos.length - 1 && (
              <span className="pin-more">+{more}</span>
            )}
          </button>
        ) : null
      )}
    </div>
  );
}

/**
 * Renders the model's light markdown as real blocks so replies read like a
 * chat, not one wall of text: blank lines separate paragraphs, runs of
 * "- "/"1. " lines become <ul>/<ol>, "## " headings and "---" rules give the
 * opening plan summary its document structure, and a `[pins: …]` line becomes
 * the day's photo strip. A full markdown library isn't worth the weight for the
 * handful of constructs the persona actually writes.
 */
function FormattedText({
  text,
  spots = [],
  onSelectSpot,
}: {
  text: string;
  spots?: Spot[];
  onSelectSpot?: (id: string) => void;
}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  // Consecutive [stay: …] lines are one card, not one card each.
  let stays: { area: string; nights: string; why: string }[] = [];

  const flushStays = () => {
    if (!stays.length) return;
    blocks.push(<StayStrip key={blocks.length} bases={stays} />);
    stays = [];
  };
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
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      flushList();
      // Two levels are all a 400px column can carry: the day (title step) and
      // its parts (body, medium).
      const level = heading[1].length <= 2 ? 1 : 2;
      blocks.push(
        <div key={blocks.length} className={`pm-h pm-h${level}`}>
          {inline(heading[2])}
        </div>
      );
      continue;
    }
    if (RULE_RE.test(line)) {
      flushPara();
      flushList();
      blocks.push(<hr key={blocks.length} className="pm-rule" />);
      continue;
    }
    if (PINS_PARTIAL_RE.test(line) || STAY_PARTIAL_RE.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const stay = line.match(STAY_RE);
    if (stay) {
      flushPara();
      flushList();
      stays.push(parseStayLine(stay[1]));
      continue;
    }
    // A run of stay lines has ended — emit the card before whatever follows.
    flushStays();
    const pins = line.match(PINS_RE);
    if (pins) {
      flushPara();
      flushList();
      const picked = resolvePins(pins[1], spots);
      // A directive naming nothing we have renders as nothing — never as the
      // raw text, which would leak the syntax into the conversation.
      if (picked.length > 0) {
        blocks.push(
          <PinStrip key={blocks.length} spots={picked} onSelectSpot={onSelectSpot} />
        );
      }
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
  flushStays();

  return <>{blocks}</>;
}

// Module scope so the request-time callback reads the ref outside render
// (react-hooks/refs). The transport is created once per trip; the ref always
// holds the latest trip + itinerary when a request actually fires.
/**
 * The three spots to offer as "anything you must include?".
 *
 * This used to be the top three by mention count across all categories, which
 * works on a balanced map and fails badly on a skewed one. On the shipped Sri
 * Lanka trip — 31 of 71 spots are food — it asked a first-time visitor to a
 * ten-day trip whether they must include `Shady Lane`, `Nomads` and
 * `Petty Petty`: two cafés and a beach club, offered as the icons of a country.
 * The very first personalisation question was steering away from what the
 * traveler came for.
 *
 * Three corrections, in order of effect:
 *  - weight by how iconic a CATEGORY is (nobody's must-see is a café),
 *  - boost anything matching the trip's stated interests, so a clubbing trip
 *    surfaces nightlife,
 *  - never offer three of the same category — variety is what makes the
 *    question answerable.
 */
const ICONIC_WEIGHT: Partial<Record<SpotCategory, number>> = {
  landmark: 1.6,
  nature: 1.5,
  beach: 1.4,
  viewpoint: 1.3,
  activity: 1.2,
  museum: 1.1,
  town: 1.0,
  market: 1.0,
  wellness: 0.9,
  nightlife: 0.9,
  shopping: 0.6,
  food: 0.45,
  other: 0.5,
  stay: 0.2,
};

/** What people type vs what the extractor calls it. Small and hand-kept: the
 *  interests field is free text and these are the words that actually show up. */
const INTEREST_SYNONYMS: Record<string, SpotCategory[]> = {
  clubbing: ["nightlife"],
  club: ["nightlife"],
  clubs: ["nightlife"],
  party: ["nightlife"],
  parties: ["nightlife"],
  bars: ["nightlife"],
  drinks: ["nightlife"],
  nightlife: ["nightlife"],
  food: ["food", "market"],
  eating: ["food"],
  restaurants: ["food"],
  street: ["food", "market"],
  hiking: ["nature", "activity"],
  trekking: ["nature", "activity"],
  wildlife: ["nature", "activity"],
  nature: ["nature"],
  waterfalls: ["nature"],
  diving: ["activity"],
  snorkelling: ["activity", "beach"],
  snorkeling: ["activity", "beach"],
  surfing: ["beach", "activity"],
  beaches: ["beach"],
  museums: ["museum"],
  history: ["landmark", "museum"],
  temples: ["landmark"],
  culture: ["landmark", "museum"],
  shopping: ["shopping", "market"],
  markets: ["market"],
  spa: ["wellness"],
  onsen: ["wellness"],
  wellness: ["wellness"],
  views: ["viewpoint"],
  viewpoints: ["viewpoint"],
  sunsets: ["viewpoint", "beach"],
};

function pickIconicSpots(trip: Trip): string[] {
  const interestWords = (trip.query?.interests ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2);
  const scored = trip.spots
    .filter((s) => !s.outOfBounds)
    .map((s) => {
      const base = Math.max(1, s.mentions.length);
      const weight = ICONIC_WEIGHT[s.category] ?? 0.8;
      // A stated interest is the traveler telling us what they're here for —
      // it should outrank generic popularity. Match the category name against
      // the interest words in either direction ("clubbing" ↔ "nightlife" needs
      // the synonym map below; "beaches" ↔ "beach" only needs a prefix).
      const wanted = interestWords.some(
        (w) =>
          s.category.startsWith(w.slice(0, 4)) ||
          (INTEREST_SYNONYMS[w] ?? []).includes(s.category)
      )
        ? 1.8
        : 1;
      return { spot: s, score: base * weight * wanted };
    })
    .sort((a, b) => b.score - a.score);

  const picked: typeof scored = [];
  const usedCats = new Set<SpotCategory>();
  // First pass: best of each category, so the three options are three
  // different kinds of thing.
  for (const entry of scored) {
    if (picked.length >= 3) break;
    if (usedCats.has(entry.spot.category)) continue;
    usedCats.add(entry.spot.category);
    picked.push(entry);
  }
  // Backfill if the trip genuinely only has one or two categories.
  for (const entry of scored) {
    if (picked.length >= 3) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked.map((e) => e.spot.name);
}

/** A day heading in an assistant reply: "## Day 3 — …", "Day 1:", "**Day 2**". */

/**
 * The shape-first step (persona §PLAN IN TWO STEPS) is deliberate and good: the
 * agent sketches the trip in prose, the traveler reacts, and only then do thirty
 * pins land on the map. Rearranging a paragraph is cheap; rearranging a placed
 * plan is not.
 *
 * What it lacked was a bound. Live testing found whole conversations that never
 * escaped it — four messages, five minutes, a beautifully written ten-day plan,
 * and an empty map, because each reply produced another summary instead of a
 * tool call. The rule allows ONE revision; this counts the summaries and, on the
 * third, tells the route to force the commit (COMMIT_NUDGE).
 *
 * Deliberately narrow: it only fires while the trip has NO plan at all, and any
 * update_itinerary anywhere in the conversation switches it off for good. A trip
 * that already has an itinerary is allowed to talk as much as it likes.
 */
function needsCommitNudge(messages: UIMessage[], plans: Itinerary[]): boolean {
  if (plans.length > 0) return false;
  let described = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.parts.some((p) => p.type === "tool-update_itinerary")) return false;
    const text = m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    if (DAY_STRUCTURE_RE.test(text)) described++;
  }
  return described >= 2;
}

/* ---------------------------------------------------------------------------
 * Keeping the promise (§4.11 layer 4).
 *
 * While the build is still reading videos the planner refuses to write a plan
 * and says so — "I'll lay out the days as soon as the map is complete". Then
 * the gate lifted in silence. The traveler had to spot that the build had
 * finished and ask a second time, which is a strange thing to ask of someone
 * who was just told to sit tight.
 *
 * So the panel notices the build land and hands the turn back to the agent.
 * The trigger has to be a USER-role message for the model to answer it, but it
 * is not something the traveler said, so it renders as an event line rather
 * than a bubble — putting words in their mouth in a transcript they can scroll
 * back through is exactly the kind of invented fact the persona forbids.
 * ------------------------------------------------------------------------- */

const MAP_READY_KIND = "map-ready";

function mapReadyText(videos: number, spots: number): string {
  return `The map has finished building — ${videos} video${
    videos === 1 ? "" : "s"
  } read, ${spots} spot${spots === 1 ? "" : "s"} on it now. This is the complete set.`;
}

function isMapReadyTurn(m: UIMessage): boolean {
  return (
    m.role === "user" &&
    (m.metadata as { kind?: string } | undefined)?.kind === MAP_READY_KIND
  );
}

function mapReadyLabel(m: UIMessage): string {
  const text = m.parts.find((p) => p.type === "text");
  const spots = text && text.type === "text" ? /(\d+) spots? on it/.exec(text.text) : null;
  return spots ? `Map complete — ${spots[1]} spots` : "Map complete";
}

/** How many refused writes we let the agent make before we stop handing the
 *  turn back. Two: the first refusal teaches it something it didn't know, a
 *  second is worth one more try, a third is a loop. */
const MAX_REFUSED_WRITES = 2;

/**
 * Is this conversation going round in circles on a refused write?
 *
 * `update_itinerary` can legitimately REFUSE — most often because the map is
 * still being built (§4.11). A refusal comes back as a normal tool output, and
 * a completed tool call is exactly what `lastAssistantMessageIsCompleteWithToolCalls`
 * auto-resends on. So the agent gets the turn back, tries again, is refused
 * again, and hands the turn back again. Reported as the planner "getting stuck
 * and repeating" — eight identical passes of the same reasoning, each one a
 * full Sonnet turn on a 30KB prompt, none of which could ever have succeeded
 * because the thing it was waiting on is a build that had not finished.
 *
 * The refusal text asks it to stop. That is steering, and §4.1 is the standing
 * lesson about what steering is worth without a structural bound — so here is
 * the bound. Counted since the traveler's last message, because their next
 * message is a genuinely new situation and deserves a fresh budget.
 */
function refusalLoop(messages: UIMessage[]): boolean {
  let refused = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (
        p.type === "tool-update_itinerary" &&
        "state" in p &&
        p.state === "output-available" &&
        (p.output as { ok?: boolean } | undefined)?.ok === false
      ) {
        refused++;
      }
    }
  }
  return refused >= MAX_REFUSED_WRITES;
}

/** The SDK's own auto-continue rule, named so the rest of the panel can defer
 *  to it instead of racing it. Anything that would start a turn off the same
 *  `messages` change must ask this first — see `turnStarted`. */
function willAutoContinue(messages: UIMessage[]): boolean {
  return (
    lastAssistantMessageIsCompleteWithToolCalls({ messages }) &&
    !refusalLoop(messages)
  );
}

function makeTransport(
  tripId: string,
  ctxRef: { current: PlannerCtx },
  turnStarted: { current: boolean }
) {
  return new DefaultChatTransport({
    api: `/api/trips/${tripId}/chat`,
    prepareSendMessagesRequest: ({ messages }) => {
      // Every outgoing turn passes through here, including the ones the SDK
      // starts by itself (`sendAutomaticallyWhen`) — which is the only hook
      // those get. Latching here means a trigger in the panel cannot start a
      // second turn on top of one the SDK already began.
      turnStarted.current = true;
      // Any turn that goes out after the map has landed keeps the promise on
      // its own — whether the traveler typed, answered a question card, or a
      // tool round-trip carried the conversation forward. Clearing here rather
      // than in one call site is what stops the pickup from arriving on top of
      // an exchange that already continued without it.
      if (!buildProgress(ctxRef.current.trip).running) clearPlanDeferred(tripId);
      return {
      body: {
        messages: windowMessages(messages),
        context: buildPlannerContext(
          ctxRef.current.trip,
          ctxRef.current.plans,
          ctxRef.current.activePlanId,
          ctxRef.current.mustSeeIds
        ),
        traceId: ctxRef.current.traceId,
        // Measured on the FULL history, not the send window — the shape turns
        // that need catching can already have scrolled out of it.
        commitNow: needsCommitNudge(messages, ctxRef.current.plans),
      },
      };
    },
  });
}

/** One trip has ONE conversation — it lives in localStorage and survives
 *  minimize, refresh, and coming back days later. */
export default function PlannerChat({
  trip,
  isLocal,
  plans,
  activePlanId,
  mustSeeIds,
  onPlansChange,
  onShowPlan,
  composeRef,
  onSelectSpot,
}: {
  trip: Trip;
  isLocal: boolean;
  /** The trip's parallel plan options, oldest first. */
  plans: Itinerary[];
  /** The option the rail is showing (the one the agent edits by default). */
  activePlanId: string | null;
  mustSeeIds: string[];
  /** A tool wrote the option list. `focusId` is the option to bring to the
   *  front — the one just written, or a survivor after a discard. */
  onPlansChange: (plans: Itinerary[], focusId: string | null) => void;
  /** Brings an option to the front from a "plan written" card in the thread. */
  onShowPlan?: (planId: string) => void;
  /** Filled with a "put this in the composer" callback, so the rail's
   *  "+ option" tab can start the sentence for the traveler. */
  composeRef?: React.MutableRefObject<((text: string) => void) | null>;
  /** Opens a spot from the summary's photo strips. */
  onSelectSpot?: (id: string) => void;
}) {
  const initialMessages = useMemo(() => loadChat(trip.id), [trip.id]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Visitors who haven't built a trip of their own only ever see this panel on
  // a sample trip — greet them with a create-your-first-trip nudge instead of
  // the planning intro. "Test-drive" dismisses it for this page view.
  // Drives the create-your-first-trip nudge. Starts from what this browser can
  // answer instantly, then confirms against the account (where a signed-in
  // user's trips actually live).
  const [hasOwnTrips, setHasOwnTrips] = useState(
    () => listLocalTrips().length > 0 || readOwnedIds().length > 0
  );
  useEffect(() => {
    if (hasOwnTrips) return;
    let cancelled = false;
    void (async () => {
      if ((await tripStoreMode()) !== "server") return;
      const res = await fetch("/api/me/trips").catch(() => null);
      const trips = res?.ok ? await res.json().catch(() => null) : null;
      if (!cancelled && Array.isArray(trips) && trips.length > 0) setHasOwnTrips(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasOwnTrips]);
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

  // Opening intake: a leaning strip of the best-loved spots' photos
  // under the greeting, and the hook that lets the composer answer the
  // current scripted question instead of messaging the LLM.
  const stripPhotos = useMemo(() => {
    return [...trip.spots]
      .sort((a, b) => b.mentions.length - a.mentions.length)
      .map((s) => spotCoverUrl(s))
      .filter((u): u is string => Boolean(u))
      .slice(0, 5);
  }, [trip]);
  const intakeAnswerRef = useRef<((text: string) => void) | null>(null);
  // Set while the agent's ask_questions card is open (§A1). Typing in the
  // composer answers that card instead of sending a message the card's tool
  // call would never see.
  const askAnswerRef = useRef<((text: string) => void) | null>(null);
  /** Whether the open card was answered by typing rather than tapping — the
   *  signal that used to be a dead end (§A1), now just a stat. */
  const answeredByTyping = useRef(false);
  /** Options written since the traveler's last message. Cleared in send(), so
   *  "this turn" means "since they last spoke" — which is what they experience,
   *  and includes the auto-continued post-tool-call round. */
  const writtenThisTurn = useRef<Map<string, boolean>>(new Map());
  // "Arugam Bay, Sri Lanka" → "Sri Lanka"; fall back to the trip's name.
  const shortDest =
    trip.destination?.name.split(",").map((s) => s.trim()).pop() || trip.name;

  /** One chat runs ONE turn at a time. `status` is the SDK's answer to "is a
   *  turn running", but it lands a commit AFTER the send — so two triggers
   *  reading the same `messages` change both see `busy === false` and both
   *  send. Not theoretical: answering a question card once started the SDK's
   *  auto-continue and the §4.11 pickup 125ms apart, and the traveler watched
   *  two full plans stream into one transcript (§4.14). Written synchronously
   *  at the moment a turn is decided on, so the second trigger sees it. */
  const turnStarted = useRef(false);

  // The transport is created once; the ctx ref keeps the request body current.
  const ctxRef = useRef<PlannerCtx>({
    trip,
    plans,
    activePlanId,
    mustSeeIds,
    traceId: crypto.randomUUID(),
  });
  useEffect(() => {
    ctxRef.current.trip = trip;
    ctxRef.current.plans = plans;
    ctxRef.current.activePlanId = activePlanId;
    ctxRef.current.mustSeeIds = mustSeeIds;
  }, [trip, plans, activePlanId, mustSeeIds]);

  // The option on screen — what "the plan" means to both the traveler and the
  // agent at this moment.
  const shownPlan = useMemo(
    () => activePlan(plans, activePlanId),
    [plans, activePlanId]
  );

  // Starred must-sees that the agent hasn't placed in the plan yet. The bar
  // nudges the user to fit these in, so it should hide once they're all
  // planned — even though the spots stay starred in the location pane.
  // Measured against the option on screen: a spot that's in some other option
  // still isn't in the one they're looking at.
  const unplannedMustSeeIds = useMemo(() => {
    const planned = new Set(
      (shownPlan?.days ?? []).flatMap((d) => d.stops.map((s) => s.spotId))
    );
    return mustSeeIds.filter((id) => !planned.has(id));
  }, [shownPlan, mustSeeIds]);

  // Instant intake — a few universal questions rendered client-side (no model
  // round-trip). Answers compile into the first message; the agent then
  // proposes the rough shape (route persona §PLAN IN TWO STEPS). Dates only if
  // the trip has none set.
  const intakeQuestions = useMemo<PlannerQuestion[]>(() => {
    const iconic = pickIconicSpots(trip);
    const hasDates = Boolean(trip.query?.startDate && trip.query?.endDate);
    return [
      { id: "who", prompt: "Who's going?", options: ["Solo", "Couple", "Family", "Friends"], allowOther: true },
      { id: "pace", prompt: "How packed should it be?", options: ["Relaxed", "Balanced", "Packed"], allowOther: true },
      // Asked HERE rather than left to the agent, because it is structural:
      // where you sleep decides which spots are even reachable, and the fast
      // path ("just plan it") skipped straight past it. `allowOther` is the
      // important part — it lets someone type "Uluwatu 2 nights, Canggu 3,
      // Ubud 4" and have the whole basing plan land in one answer.
      {
        id: "stay",
        prompt: "Sorted where you're staying?",
        options: ["Not yet — suggest areas", "Booked already", "With friends or family"],
        allowOther: true,
      },
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

  // The transport only reads the refs at request time
  // (prepareSendMessagesRequest), never during render.
  const transport = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => makeTransport(trip.id, ctxRef, turnStarted),
    [trip.id]
  );

  const { messages, setMessages, sendMessage, addToolOutput, status, error, regenerate } = useChat({
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: (opts) => willAutoContinue(opts.messages),
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;

      if (toolCall.toolName === "update_itinerary") {
        const currentTrip = ctxRef.current.trip;
        const input = toolCall.input as ItineraryInput;
        // B3, structurally. The persona says "write once per option per turn,
        // and write last"; the fixture suite showed it still writing a 40-stop
        // plan two and three times on one message — think, commit, check travel
        // times, commit again. Prose didn't hold, so refuse the second full
        // rewrite and tell it what to send instead. A patch is always allowed:
        // that's the cheap correction we WANT it to reach for.
        const alreadyWrote = writtenThisTurn.current.get(input?.planId ?? "");
        if (alreadyWrote && input?.mode !== "patch") {
          addToolOutput({
            tool: "update_itinerary",
            toolCallId: toolCall.toolCallId,
            output: {
              ok: false,
              error: `You already wrote "${input.planId}" in this turn — the traveler has watched that plan stream once. Don't rewrite it whole. If something still needs changing, send mode="patch" with just the affected days.`,
            },
          });
          return;
        }
        writtenThisTurn.current.set(input?.planId ?? "", true);
        // One call, because the read and the write must not be separated:
        // "build me both shapes" lands two of these in a single turn and React
        // hasn't re-rendered in between, so a patch base taken from props would
        // silently drop the first write.
        const {
          plans: nextPlans,
          itinerary: next,
          created,
          warnings,
          rejected,
          mode,
        } = applyPlanUpdate(currentTrip, isLocal, input, currentTrip.spots);
        if (rejected) {
          addToolOutput({
            tool: "update_itinerary",
            toolCallId: toolCall.toolCallId,
            output: { ok: false, error: rejected },
          });
          return;
        }
        onPlansChange(nextPlans, next.id ?? null);
        const planned = next.days.reduce((n, d) => n + d.stops.length, 0);
        track("itinerary_committed", {
          tripId: currentTrip.id,
          planId: next.id,
          mode,
          created,
          days: next.days.length,
          stops: planned,
          optionCount: nextPlans.length,
        });
        addToolOutput({
          tool: "update_itinerary",
          toolCallId: toolCall.toolCallId,
          output: {
            ok: true,
            warnings,
            planId: next.id,
            planTitle: next.title,
            // Which of the three things just happened, so the model's reply can
            // say "added a second option" instead of guessing.
            action: created
              ? "created a new option"
              : mode === "patch"
                ? "patched that option"
                : "replaced that option",
            optionCount: nextPlans.length,
            optionsRemaining: MAX_PLANS - nextPlans.length,
            plannedStops: planned,
            unassignedCount: currentTrip.spots.length - planned,
          },
        });
      } else if (toolCall.toolName === "discard_plan") {
        const currentTrip = ctxRef.current.trip;
        const { planId } = toolCall.input as DiscardPlanInput;
        const { plans: nextPlans, removed } = discardPlan(
          currentTrip,
          isLocal,
          planId
        );
        if (removed) onPlansChange(nextPlans, nextPlans[0]?.id ?? null);
        addToolOutput({
          tool: "discard_plan",
          toolCallId: toolCall.toolCallId,
          output: removed
            ? {
                ok: true,
                discarded: removed.title,
                remaining: nextPlans.map((p) => ({ id: p.id, title: p.title })),
              }
            : {
                ok: false,
                error: `No option with id "${planId}". Current options: ${
                  nextPlans.map((p) => p.id).join(", ") || "none"
                }.`,
              },
        });
      } else if (toolCall.toolName === "load_plan") {
        // Only the shown option rides along in full (see plansBlock). This is
        // how the model gets an inactive one back when it genuinely needs the
        // detail — a read, not a write.
        const { planId } = toolCall.input as LoadPlanInput;
        const found = ctxRef.current.plans.find((p) => p.id === planId);
        addToolOutput({
          tool: "load_plan",
          toolCallId: toolCall.toolCallId,
          output: found
            ? { ok: true, plan: found }
            : {
                ok: false,
                error: `No option with id "${planId}". Current options: ${
                  ctxRef.current.plans.map((p) => p.id).join(", ") || "none"
                }.`,
              },
        });
      } else if (toolCall.toolName === "get_travel_times") {
        const spots = new Map(ctxRef.current.trip.spots.map((s) => [s.id, s]));
        const { pairs } = toolCall.input as TravelTimesInput;
        const resolved = pairs.map(({ from, to }) => ({
          from,
          to,
          a: spots.get(from),
          b: spots.get(to),
        }));

        // Real road times where we can get them. The agent demonstrably does
        // not trust a straight-line number — it called this tool and then
        // overrode the answer from memory — so the fix is to make the number
        // true, not to argue with it.
        let road: (number | null)[] = resolved.map(() => null);
        const routable = resolved.filter((r) => r.a && r.b);
        if (routable.length > 0) {
          try {
            const res = await fetch("/api/routes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                pairs: routable.map((r) => ({
                  from: { lat: r.a!.lat, lng: r.a!.lng },
                  to: { lat: r.b!.lat, lng: r.b!.lng },
                })),
              }),
            });
            if (res.ok) {
              const data = (await res.json()) as { minutes?: (number | null)[] };
              const byIndex = new Map(
                routable.map((r, i) => [r, data.minutes?.[i] ?? null])
              );
              road = resolved.map((r) => byIndex.get(r) ?? null);
            }
          } catch {
            // Routing is an upgrade, never a dependency.
          }
        }

        const results = resolved.map((r, i) => {
          if (!r.a || !r.b) return { from: r.from, to: r.to, error: "unknown spot id" };
          const km = haversineKm(r.a.lat, r.a.lng, r.b.lat, r.b.lng);
          const est = travelEstimate(km);
          const realDrive = road[i];
          return {
            from: r.from,
            to: r.to,
            km: Number(km.toFixed(2)),
            walkMin: est.walkMin,
            driveMin: realDrive ?? est.driveMin,
            // Say which it is. An agent told "estimate" is entitled to second
            // -guess it; one told "real road time" should plan around it.
            source: realDrive != null ? ("road" as const) : ("estimate" as const),
          };
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
              : // "We found nothing" and "we found videos and couldn't read
                // them" are completely different answers to the traveler. The
                // second one told someone there are no wine bars in Tbilisi.
                res.unreadable && res.unreadable >= (res.attempted ?? 0)
                ? {
                    ok: false,
                    retryable: true,
                    message: `Found ${res.attempted} videos${
                      area ? ` for ${area}` : ""
                    } but couldn't read any of them right now (YouTube is rate-limiting us). Tell the traveler that plainly — do NOT say there's nothing there — and offer to try again shortly or plan with what's on the map.`,
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
  // Set the first time a request goes out in this session. Without it, the
  // dropped-stream notice below fires on a conversation merely *loaded* from
  // storage — the plan long since built and on the map — because it can't tell
  // "this turn died just now" from "this is how the history ends".
  const [streamedHere, setStreamedHere] = useState(false);
  if (busy && !streamedHere) setStreamedHere(true);

  // Released on the FALLING edge of `busy`, never on plain `!busy` — the whole
  // point of the latch is the window where a turn has been sent and `busy` has
  // not caught up yet, and clearing on `!busy` would clear it inside exactly
  // that window. `busy` is what unblocks the next turn from here on; the latch
  // only has to survive the gap.
  const sawBusy = useRef(false);
  useEffect(() => {
    if (busy) sawBusy.current = true;
    else if (sawBusy.current) {
      sawBusy.current = false;
      turnStarted.current = false;
    }
  }, [busy]);

  /** The one door every turn this panel starts goes through. Checking and
   *  latching in one place is the point: a caller that reads the guard and
   *  sends two statements later has re-opened the race this closes. */
  const startTurn = useCallback(
    (run: () => void) => {
      if (busy || turnStarted.current) return false;
      turnStarted.current = true;
      run();
      return true;
    },
    [busy]
  );

  // A big plan payload sometimes arrives as malformed tool input
  // (AI_InvalidToolInputError wrapping AI_JSONParseError). It's transient — the
  // same turn regenerated usually lands — but today the traveler eats a raw SDK
  // string and loses the whole plan. Retry once, silently, per failed turn; the
  // rendered message below is only reached if the retry fails too.
  /** Retries of a THROWN update_itinerary since the traveler last spoke.
   *
   *  This was a Set of message ids, which does not bound anything: regenerate()
   *  replaces the last assistant message with a NEW one carrying a NEW id, so a
   *  failure that reproduces is never recognised as the same failure and the
   *  "retry once" is really "retry forever". A counter reset on the traveler's
   *  next message is the honest version of what the comment always claimed. */
  const toolRetries = useRef(0);
  useEffect(() => {
    if (busy) return;
    const tail = messages[messages.length - 1];
    if (!tail || tail.role !== "assistant") return;
    const toolFailed = tail.parts.some(
      (p) =>
        p.type === "tool-update_itinerary" &&
        "state" in p &&
        p.state === "output-error"
    );
    if (!toolFailed || toolRetries.current >= 1) return;
    // Spend the one retry only if it actually goes out. A turn already starting
    // means this effect re-runs on the falling edge of `busy` with the budget
    // still intact — burning it here would swallow the retry silently.
    if (!startTurn(() => void regenerate())) return;
    toolRetries.current += 1;
    console.warn("[planner] update_itinerary tool input failed — retrying once");
    // The raw error goes to analytics, not to the traveler (§A5). Without this
    // the failure is invisible: LLM analytics records the generation as normal.
    track("planner_tool_error", {
      tripId: trip.id,
      tool: "update_itinerary",
      errorText:
        tail.parts
          .map((p) =>
            p.type === "tool-update_itinerary" &&
            "state" in p &&
            p.state === "output-error"
              ? p.errorText
              : ""
          )
          .find(Boolean) ?? "",
      retried: true,
    });
  }, [messages, busy, regenerate, startTurn, trip.id]);

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
    streamedHere &&
    !busy &&
    !error &&
    (last?.role === "user" || lastAssistantEmpty);

  // Where the traveler is. A long reply streams for a minute or more, and this
  // effect ran on every chunk of it — so scrolling up to read what had already
  // arrived yanked you straight back to the bottom, and the prose was
  // unreadable until the turn finished. Reported exactly that way.
  //
  // The rule instead: follow the stream only while they are ALREADY at the
  // bottom. The moment they scroll up they have taken control, and they keep
  // it until they come back down. Read in the handler rather than on every
  // render — this is the scroll position, not React state.
  const stickToBottom = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A generous threshold: "near the bottom" has to survive the layout shift
    // of a chunk landing, or one unlucky frame detaches them mid-read.
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    // Not before the conversation starts: with no messages the panel shows the
    // intro/nudge, and in a short panel (the mobile half-height sheet) jumping
    // to the bottom would clip the top of it — the photo fan cut mid-frame
    // reads as broken layout.
    if (messages.length === 0) return;
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, error, streamDropped]);

  // A message they sent is theirs — always follow that one down, even if they
  // had scrolled up to re-read something first.
  const lastRoleForScroll = messages[messages.length - 1]?.role;
  useEffect(() => {
    if (lastRoleForScroll !== "user") return;
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastRoleForScroll, messages.length]);

  // A trip opened on a fresh device has no localStorage chat — pull the
  // account's saved conversation. Local always wins when it exists (it is
  // what got synced up in the first place).
  useEffect(() => {
    if (!trip.ownerId || initialMessages.length > 0) return;
    let cancelled = false;
    void fetchServerChat(trip.id).then((msgs) => {
      if (cancelled || !msgs || msgs.length === 0) return;
      // What the account has is not something to write back.
      noteChatFromServer(trip.id, msgs);
      // Updater form: if the user already typed while we fetched, keep theirs.
      setMessages((cur) => (cur.length > 0 ? cur : sanitizeChat(msgs as UIMessage[])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id]);

  // Persist only BETWEEN turns. Mid-stream the array is a half-message —
  // usually a reasoning block with nothing after it — and storing that is how a
  // finished plan came back looking like a dropped connection. Streaming churn
  // used to be handled with a debounce, which is a race, not a rule: a long
  // think would outlast it and the snapshot would land.
  const messagesRef = useRef(initialMessages);
  useEffect(() => {
    messagesRef.current = messages;
    if (messages.length === 0 || busy) return;
    const t = setTimeout(() => void saveChat(trip.id, messages), 400);
    // Owned trips go up to the account right now — this only runs between
    // turns, so it's one write per turn, and nothing is left pending for a
    // navigation to cancel.
    if (trip.ownerId) pushChat(trip.id, messages.slice(-CHAT_MAX_MESSAGES));
    return () => clearTimeout(t);
  }, [messages, busy, trip.id, trip.ownerId]);

  // Leaving the page must not cost the last turn: a client-side navigation
  // unmounts this panel while its debounce is still pending, and the account
  // push would never fire. Flush immediately on unmount, and hand the browser a
  // beacon for a real unload (close/reload), which cancels in-flight requests.
  useEffect(() => {
    const flush = (beacon: boolean) => {
      const msgs = messagesRef.current;
      if (msgs.length === 0) return;
      void saveChat(trip.id, msgs);
      if (trip.ownerId) pushChat(trip.id, msgs.slice(-CHAT_MAX_MESSAGES), beacon);
    };
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush(false);
    };
  }, [trip.id, trip.ownerId]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Dropped rather than queued when a turn is already starting — and the
    // composer keeps the text, so the next tap sends it.
    const sent = startTurn(() => {
      // New turn: the "you already wrote this option" guard measures from here,
      // and so does the tool-retry budget — their next message is a genuinely
      // new situation, not a continuation of whatever was failing.
      writtenThisTurn.current.clear();
      toolRetries.current = 0;
      sendMessage({ text: trimmed });
    });
    if (!sent) return;
    setInput("");
    const el = inputRef.current;
    if (el) el.style.height = "auto";
  }

  // ---- The build landed: hand the turn back to the agent (§4.11 layer 4) ----

  const build = buildProgress(trip);
  const hasConversation = messages.some((m) => m.role === "assistant");
  const pickedUp = useRef(false);

  // The promise is made whenever the agent answers while the map is still
  // filling — that's the turn where it says "I'll plan once this is done".
  // Recorded per trip because the wait is precisely when people navigate away.
  useEffect(() => {
    if (build.running && hasConversation) markPlanDeferred(trip.id);
  }, [build.running, hasConversation, trip.id]);

  // A question card is on screen waiting on this person. Derived from messages
  // rather than the answer refs so the effect below actually re-runs when it
  // changes — and because barging in here would strand the tool call, which is
  // the exact bug §A1 exists to prevent.
  const awaitingAnswer = messages.some(
    (m) =>
      m.role === "assistant" &&
      m.parts.some(
        (p) =>
          p.type === "tool-ask_questions" &&
          "state" in p &&
          p.state !== "output-available" &&
          p.state !== "output-error"
      )
  );
  const lastRole = messages[messages.length - 1]?.role;
  // The SDK is about to continue a finished tool round-trip on its own. That
  // turn is built from fresh context, so it already carries the complete map —
  // the nudge would add nothing and start a second turn on the same chat.
  const autoContinuing = willAutoContinue(messages);

  useEffect(() => {
    if (pickedUp.current || build.running || busy) return;
    // Deferring to the SDK by testing the SAME condition it tests, rather than
    // waiting to observe that it sent: `busy` and the transport's
    // clearPlanDeferred both land a commit late, so answering a question card
    // satisfied this effect and `sendAutomaticallyWhen` off one `messages`
    // change and fired both (§4.14).
    if (autoContinuing) return;
    // Nothing was promised, or it's already been kept.
    if (!hasConversation || !planWasDeferred(trip.id)) return;
    // A plan already exists — the map growing under it is a different problem
    // (offer to redo it), and silently starting a new turn is not the answer.
    if (plans.length > 0) return;
    // A build that died with nothing to show has no good news to deliver.
    if (trip.spots.length === 0) return;
    // The agent has to have spoken last, with nothing outstanding. Anything
    // else means the traveler is mid-exchange, and the pickup would be talking
    // over someone who is already getting what they need.
    if (lastRole !== "assistant" || awaitingAnswer) return;

    const sent = startTurn(() => {
      // Cleared BEFORE the send, not after: a reload mid-stream would otherwise
      // find the flag still set and pick up a second time.
      pickedUp.current = true;
      clearPlanDeferred(trip.id);
      writtenThisTurn.current.clear();
      sendMessage({
        text: mapReadyText(build.videosRead, trip.spots.length),
        metadata: { kind: MAP_READY_KIND },
      });
    });
    if (!sent) return;
    track("planner_picked_up", {
      tripId: trip.id,
      spots: trip.spots.length,
      videos: build.videosRead,
    });
  }, [
    autoContinuing,
    awaitingAnswer,
    build.running,
    build.videosRead,
    busy,
    hasConversation,
    lastRole,
    plans.length,
    sendMessage,
    startTurn,
    trip.id,
    trip.spots.length,
  ]);

  // Instant intake answers → one compiled first message. The agent (persona)
  // then proposes the rough shape rather than a full pin plan.
  function submitIntake(answers: QuestionAnswer[]) {
    const stated = answers.filter(
      (a) => a.answer && a.answer !== "no preference"
    );
    // "Plan my days" reads to the agent as "just plan it", which is the
    // documented skip-the-shape fast path. That's right when they've sorted
    // where they're sleeping and wrong when they haven't: days built on a base
    // they never chose aren't days they can agree to. So when the stay answer
    // is unresolved, ask for the basing FIRST, in their own words.
    const unsorted = answers.some(
      (a) => a.id === "stay" && /^not yet/i.test(a.answer.trim())
    );
    const ask = unsorted
      ? "I haven't booked anywhere yet — tell me which areas to base in and for how many nights, then plan the days around that."
      : "Plan my days.";
    send(
      stated.length
        ? `Here's my trip:\n${stated
            .map((a) => `- ${a.prompt} ${a.answer}`)
            .join("\n")}\n\n${ask}`
        : ask
    );
  }

  // Grow with the content (up to ~5 lines), like any modern chat input.
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  // The rail's "+ option" tab drops a half-written ask into the composer
  // rather than firing a message the traveler never phrased — building an
  // option is a real model turn, so they get to say what it should be.
  // Same idiom as intakeAnswerRef: a callback handed up through a ref, which
  // beats reaching into a controlled textarea's value from outside React.
  useEffect(() => {
    if (!composeRef) return;
    composeRef.current = (text: string) => {
      setInput(text);
      const el = inputRef.current;
      if (el) {
        el.focus();
        autosize(el);
        // Caret at the end, so they type straight into the sentence.
        requestAnimationFrame(() =>
          el.setSelectionRange(text.length, text.length)
        );
      }
    };
    return () => {
      composeRef.current = null;
    };
  }, [composeRef]);

  // Composer submit. While the opening intake is running, typed
  // text answers the current scripted question instead of messaging the LLM
  // (routing lives here — NOT in send(), which submitIntake itself calls to
  // deliver the compiled answers).
  function submitComposer() {
    const trimmed = input.trim();
    // Opening intake first, then the agent's own question card: in both cases
    // there is a question on screen waiting on this person, and a free-form
    // message would either be ignored (intake) or strand a tool call (card).
    const answer = intakeAnswerRef.current ?? askAnswerRef.current;
    if (trimmed && answer) {
      if (!intakeAnswerRef.current) answeredByTyping.current = true;
      answer(trimmed);
      setInput("");
      const el = inputRef.current;
      if (el) el.style.height = "auto";
      return;
    }
    send(input);
  }

  const showNudge = !hasOwnTrips && !isLocal && !nudgeDismissed;
  // A question is on screen waiting on this person — the composer answers it
  // rather than starting a new thought. Read during render, so it's derived
  // from the same refs submitComposer uses.
  const answering = Boolean(intakeAnswerRef.current ?? askAnswerRef.current);

  return (
    <aside className="planner-panel" onClick={(e) => e.stopPropagation()}>
      <div className="planner-scroll" ref={scrollRef} onScroll={onScroll}>
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
          ) : plans.length === 0 ? (
            <ConversationalIntake
              title={`Let’s plan your days in ${shortDest}`}
              photos={stripPhotos}
              questions={intakeQuestions}
              answerRef={intakeAnswerRef}
              onSubmit={submitIntake}
            />
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
          isMapReadyTurn(message) ? (
            // The pickup's trigger. It has to be a user-role turn for the model
            // to answer it, but it is NOT something the traveler said, so it
            // does not get a traveler's bubble — it renders as what it actually
            // is, the build finishing.
            <div key={message.id} className="pm-landed">
              <span className="pm-landed-dot" aria-hidden="true" />
              {mapReadyLabel(message)}
            </div>
          ) : (
          <div key={message.id} className={`pm pm-${message.role}`}>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <div key={i} className="pm-text">
                    <FormattedText
                      text={part.text}
                      spots={trip.spots}
                      onSelectSpot={onSelectSpot}
                    />
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
                  const out = part.output as
                    | { ok?: boolean; error?: string; action?: string }
                    | undefined;
                  // The cap was hit and nothing was written — say so plainly
                  // rather than claiming a plan landed.
                  if (out?.ok === false) {
                    return (
                      <div key={i} className="pm-tool error">
                        {out.error ?? "Couldn’t save that option."}
                      </div>
                    );
                  }
                  const input = part.input as ItineraryInput;
                  // A turn can write several options; each card is the way
                  // back to the one it wrote. Gone (discarded later) = plain
                  // card, not a button that does nothing.
                  const optionIndex = plans.findIndex((p) => p.id === input?.planId);
                  const live = optionIndex !== -1;
                  const written = live ? plans[optionIndex] : undefined;
                  // A patch call carries only the days it changed (and no
                  // title), so describe the OPTION as it now stands rather than
                  // the payload — "1 day · 4 stops" would be a lie about a
                  // ten-day trip.
                  const patching = input?.mode === "patch";
                  const days =
                    patching && written ? written.days : (input?.days ?? []);
                  const stops = days.reduce(
                    (n, d) => n + (d.stops?.length ?? 0),
                    0
                  );
                  const changed = patching
                    ? (input?.dayPatches?.length ?? 0)
                    : 0;
                  const meta = `${
                    changed > 0
                      ? `${changed} day${changed === 1 ? "" : "s"} updated · `
                      : ""
                  }${days.length} day${days.length === 1 ? "" : "s"} · ${stops} stop${
                    stops === 1 ? "" : "s"
                  }${live ? " · show it on the map" : ""}`;
                  const body = (
                    <>
                      <span className="pm-event-icon" aria-hidden="true">
                        ✓
                      </span>
                      <div className="pm-event-body">
                        <div className="pm-event-title">
                          {input?.title ?? written?.title ?? "Plan updated"}
                          {live && (
                            <span className="pm-event-badge">
                              Option {optionIndex + 1}
                            </span>
                          )}
                        </div>
                        <div className="pm-event-meta">{meta}</div>
                      </div>
                    </>
                  );
                  return live && onShowPlan ? (
                    <button
                      key={i}
                      className="pm-event pm-event-btn"
                      onClick={() => onShowPlan(input.planId)}
                    >
                      {body}
                    </button>
                  ) : (
                    <div key={i} className="pm-event">
                      {body}
                    </div>
                  );
                }
                if (part.state === "output-error") {
                  // `errorText` is raw SDK prose — "AI_InvalidToolInputError:
                  // AI_JSONParseError: … {"planId": "snow-and-food"" — which is
                  // meaningless to a traveler. The retry above usually clears
                  // it; this only renders when the retry failed too.
                  return (
                    <div key={i} className="pm-tool error">
                      That plan didn&rsquo;t come through cleanly. Ask me to try
                      again and I&rsquo;ll rebuild it.
                    </div>
                  );
                }
                return null;
              }
              if (part.type === "tool-discard_plan") {
                if (part.state !== "output-available") {
                  return (
                    <div key={i} className="pm-tool working">
                      🗑️ Dropping that option…
                    </div>
                  );
                }
                const out = part.output as
                  | { ok?: boolean; discarded?: string; error?: string }
                  | undefined;
                return (
                  <div key={i} className={`pm-tool ${out?.ok ? "done" : "error"}`}>
                    {out?.ok
                      ? `🗑️ Dropped “${out.discarded}”`
                      : (out?.error ?? "Couldn’t drop that option.")}
                  </div>
                );
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
                      answerRef={askAnswerRef}
                      onSubmit={(answers) => {
                        track("question_card_answered", {
                          tripId: trip.id,
                          questions: qs.length,
                          // Which affordance they actually used. If "type"
                          // dominates, the card is the wrong shape for the ask.
                          answeredVia: answeredByTyping.current ? "type" : "tap",
                        });
                        answeredByTyping.current = false;
                        addToolOutput({
                          tool: "ask_questions",
                          toolCallId: part.toolCallId,
                          output: answers,
                        });
                      }}
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
          )
        ))}

        {busy && <ThinkingStatus />}
        {error && (
          <div className="pm-problem">
            <div>Something went wrong: {error.message}</div>
            <button className="pm-retry" onClick={() => startTurn(() => void regenerate())}>
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
            <button className="pm-retry" onClick={() => startTurn(() => void regenerate())}>
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

      <form
        // D1 — say which of the two things typing will do. Without this the
        // composer looks identical whether or not a question card is waiting,
        // which is how travelers typed into a card and lost the conversation.
        className={`planner-inputrow${answering ? " answering" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submitComposer();
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
              submitComposer();
            }
          }}
          placeholder={
            answering
              ? "Type your answer…"
              : "Ask your local planner…"
          }
          aria-label="Message the planner"
        />
        <button type="submit" disabled={!input.trim() || busy} aria-label="Send">
          ↑
        </button>
      </form>
    </aside>
  );
}
