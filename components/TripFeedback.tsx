"use client";

import { useEffect, useRef, useState } from "react";
import { ICON_NAV } from "@/lib/ui";
import { getClientDistinctId } from "@/lib/track";
import { Trip } from "@/lib/types";

/**
 * "Feedback" — the pill next to Share, and the panel behind it.
 *
 * Two things through one box, because they're the same act from the traveler's
 * side: telling us something is wrong, and telling us what to build instead.
 * The mode switch changes the framing and where the message goes in the
 * changelog; it does NOT change the box, so someone who starts typing feedback
 * and realises it's really a feature request keeps every word.
 *
 * The prompt mode is the interesting half: it's a message written to be handed
 * to a coding agent (Conductor, Claude Code) more or less verbatim. That makes
 * LENGTH a feature rather than a smell, and it's why this is a real textarea
 * with room in it rather than a one-line "how did we do?".
 */
type Mode = "feedback" | "prompt";

const COPY: Record<
  Mode,
  { title: string; sub: string; label: string; placeholder: string; who: string; cta: string }
> = {
  feedback: {
    title: "Send feedback",
    sub: "What's working, what's broken, what you wish this did.",
    label: "Message",
    placeholder:
      "Tell us about your experience, bugs you've found, or features you'd like to see…",
    who: "Your name or email (optional — only if you want a reply)",
    cta: "Send feedback",
  },
  prompt: {
    title: "Submit a prompt",
    sub: "Describe what you want built, in as much detail as you like. Good prompts get handed to a coding agent — if we run yours, we'll credit you.",
    label: "Prompt",
    placeholder:
      "Describe what you'd like to see built. Long is good — dictating it out loud works well here.",
    who: "Your name (if we use your prompt, we'll credit you)",
    cta: "Submit prompt",
  },
};

/** Matches MIN_MESSAGE in app/api/feedback/route.ts, so the button is never
 *  enabled for something the server will reject. */
const MIN_MESSAGE = 4;
const MAX_MESSAGE = 8000;

export default function TripFeedback({ trip }: { trip?: Trip | null }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("feedback");
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const whoRef = useRef<HTMLInputElement>(null);

  // Dismiss on outside click / Escape, same as the share popover. Escape is
  // checked against the panel rather than swallowed globally so it still
  // clears a native autocomplete first.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The box IS the panel; focus it on open so dictation can start without a
  // click first. Focus only — the sent/error reset happens in the opening
  // click, where it's an event, not a render cascade.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => boxRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  async function submit() {
    // Read from the DOM, not from React state. Dictation tools (Wispr Flow and
    // friends) insert text by writing the element's value directly, and a
    // controlled component can miss — or overwrite — text that arrived that
    // way. Uncontrolled + read-at-submit is the only version that can't lose a
    // paragraph somebody spoke.
    const message = (boxRef.current?.value ?? "").trim();
    const contact = (whoRef.current?.value ?? "").trim();
    if (busy || message.length < MIN_MESSAGE) return;
    setBusy(true);
    setError(null);
    try {
      const distinctId = getClientDistinctId();
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: mode,
          message: message.slice(0, MAX_MESSAGE),
          contact,
          tripId: trip?.id,
          tripName: trip?.label || trip?.name,
          ...(distinctId ? { distinctId } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Couldn't send that.");
      }
      // No track() here on purpose: the route captures `feedback_submitted`
      // itself, with the body attached. Firing it from both sides would double
      // every count.
      if (boxRef.current) boxRef.current.value = "";
      setHasText(false);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[mode];
  const canSend = hasText && !busy;

  return (
    <div className="trip-feedback" ref={rootRef}>
      <button
        className={`share-btn fb-btn${open ? " on" : ""}`}
        onClick={() => {
          const opening = !open;
          setOpen(opening);
          if (opening) {
            setSent(false);
            setError(null);
          }
        }}
        aria-expanded={open}
        title="Send feedback, or a prompt for something you want built"
      >
        <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M2 3.25A1.25 1.25 0 013.25 2h7.5A1.25 1.25 0 0112 3.25v5A1.25 1.25 0 0110.75 9.5H5.5L3 12V9.5A1.25 1.25 0 012 8.25v-5z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        Feedback
      </button>

      {open && (
        <div className="fb-pop" role="dialog" aria-label="Send feedback or a prompt">
          {/* One box, two framings. Switching modes must not clear the
              textarea — see the component note. */}
          <div className="fb-tabs" role="tablist">
            {(["feedback", "prompt"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`fb-tab${mode === m ? " on" : ""}`}
                onClick={() => {
                  setMode(m);
                  setSent(false);
                }}
              >
                {m === "feedback" ? "Feedback" : "Build this"}
              </button>
            ))}
          </div>

          {sent ? (
            <div className="fb-done">
              <div className="fb-pop-title">
                {mode === "prompt" ? "Prompt received" : "Thank you"}
              </div>
              <p className="fb-pop-sub">
                {mode === "prompt"
                  ? "If we run it, you'll see it in the changelog."
                  : "Read by a human, not a dashboard."}
              </p>
              <button className="fb-again" onClick={() => setSent(false)}>
                Send another
              </button>
            </div>
          ) : (
            <>
              <div className="fb-pop-title">{copy.title}</div>
              <p className="fb-pop-sub">{copy.sub}</p>

              <label className="fb-label" htmlFor="fb-message">
                {copy.label}
              </label>
              <textarea
                id="fb-message"
                ref={boxRef}
                className="fb-box"
                rows={mode === "prompt" ? 7 : 5}
                maxLength={MAX_MESSAGE}
                placeholder={copy.placeholder}
                // Uncontrolled on purpose (see submit()). This only tracks
                // whether the button should be live.
                onInput={(e) =>
                  setHasText(e.currentTarget.value.trim().length >= MIN_MESSAGE)
                }
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />

              <label className="fb-label" htmlFor="fb-who">
                {copy.who}
              </label>
              <input id="fb-who" ref={whoRef} className="fb-who" type="text" />

              {error && <p className="fb-error">{error}</p>}

              <div className="fb-actions">
                <button className="fb-send" onClick={() => void submit()} disabled={!canSend}>
                  {busy ? "Sending…" : copy.cta}
                  <span className="fb-kbd" aria-hidden="true">
                    ⌘↵
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
