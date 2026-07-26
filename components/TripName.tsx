"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { MAX_TRIP_LABEL } from "@/lib/tripName";

// The trip's title, rendered as a heading until you double-click it — then the
// same text becomes an input sitting in the same place, at the same size, so
// renaming reads as writing over the title rather than opening a dialog.
//
// It renames the *label* only (lib/tripName.ts): the destination, the map and
// the flag beside it are whatever the planner resolved, and stay put.

export default function TripName({
  name,
  flag,
  onRename,
  className,
}: {
  name: string;
  /** Country flag emoji, when the destination named a country we recognise. */
  flag?: string | null;
  /** Absent = this title is read-only (no rename affordance at all). */
  onRename?: (name: string) => void;
  /** The heading class of whichever header is rendering us. */
  className: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  // An input can't size itself to its text, and the title lives in a grid cell
  // that would happily stretch it across a third of the header. So a hidden
  // span holding the same text in the same font measures the draft, and the
  // input takes that width (capped at the cell, which is what `max-width`
  // does) — the box grows as you type and never jumps on the way in.
  const sizerRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (editing && sizerRef.current) setWidth(sizerRef.current.offsetWidth);
  }, [editing, draft]);

  const open = () => setDraft(name);

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    // Unchanged, or blanked back to the name it already shows: nothing to save.
    if (next !== name) onRename?.(next);
  };

  if (!onRename) {
    return (
      <h1 className={className}>
        {/* Decorative: the country is already in the name beside it. */}
        {flag && (
          <span className="trip-flag" aria-hidden="true">
            {flag}
          </span>
        )}
        <span className="trip-name-text">{name}</span>
      </h1>
    );
  }

  return (
    <h1 className={className}>
      {flag && (
        <span className="trip-flag" aria-hidden="true">
          {flag}
        </span>
      )}
      {editing ? (
        <>
          <input
            className="trip-name-input"
            value={draft}
            autoFocus
            maxLength={MAX_TRIP_LABEL}
            aria-label="Trip name"
            style={{ width: width || undefined }}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(null);
              }
            }}
          />
          <span className="trip-name-sizer" ref={sizerRef} aria-hidden="true">
            {draft || name}
          </span>
        </>
      ) : (
        <span
          className="trip-name-text editable"
          tabIndex={0}
          title="Double-click to rename"
          onDoubleClick={open}
          onKeyDown={(e) => {
            // Keyboard equivalent of the double-click — a rename shouldn't
            // need a mouse. F2 is the desktop convention; Enter is the guess
            // anyone makes on a focused title.
            if (e.key === "Enter" || e.key === "F2") {
              e.preventDefault();
              open();
            }
          }}
        >
          {name}
        </span>
      )}
    </h1>
  );
}
