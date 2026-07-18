"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A calendar date picker that matches the landing page's sky/blue design —
// replaces the browser's unstyleable native `<input type="date">` popup.
// Dates are plain `yyyy-mm-dd` strings, parsed and formatted in local time so
// there's no timezone drift (never `new Date("2026-07-17")`, which is UTC).

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type Props = {
  label: string;
  value: string; // yyyy-mm-dd, or "" when unset
  onChange: (value: string) => void;
  min?: string; // yyyy-mm-dd — days before this are disabled
  disabled?: boolean;
  placeholder?: string;
};

// yyyy-mm-dd -> {y, m, d} (m is 1-based), or null for empty/invalid.
function parse(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { y: +match[1], m: +match[2], d: +match[3] };
}

function toKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

// Weekday index (0=Sun) of the first day of a month.
function firstWeekday(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

export default function DatePicker({
  label,
  value,
  onChange,
  min,
  disabled,
  placeholder = "Add date",
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [dropUp, setDropUp] = useState(false);

  const selected = parse(value);
  const today = new Date();
  const todayKey = toKey(today.getFullYear(), today.getMonth() + 1, today.getDate());

  // The month the grid is currently showing.
  const [view, setView] = useState(() =>
    selected ?? { y: today.getFullYear(), m: today.getMonth() + 1 }
  );

  // When the field opens, jump the grid to the selected date (or today).
  useEffect(() => {
    if (!open) return;
    const s = parse(value);
    setView(s ? { y: s.y, m: s.m } : { y: today.getFullYear(), m: today.getMonth() + 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Flip the popup above the field when there isn't room below it.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setDropUp(window.innerHeight - rect.bottom < 360);
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function shiftMonth(delta: number) {
    setView((v) => {
      const idx = v.y * 12 + (v.m - 1) + delta;
      return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
    });
  }

  function pick(day: number) {
    onChange(toKey(view.y, view.m, day));
    setOpen(false);
  }

  const total = daysInMonth(view.y, view.m);
  const lead = firstWeekday(view.y, view.m);
  const cells: (number | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];

  const display = selected
    ? new Date(selected.y, selected.m - 1, selected.d).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  return (
    <div className="dp" ref={rootRef}>
      <span className="dp-label">{label}</span>
      <button
        type="button"
        className={`dp-trigger${display ? "" : " placeholder"}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {display || placeholder}
      </button>

      {open && (
        <div
          className={`dp-pop${dropUp ? " up" : ""}`}
          role="dialog"
          aria-label={`Choose ${label} date`}
          ref={popRef}
        >
          <div className="dp-head">
            <div className="dp-month">
              {MONTHS[view.m - 1]} {view.y}
            </div>
            <div className="dp-nav">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => shiftMonth(1)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="dp-weekdays">
            {WEEKDAYS.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>

          <div className="dp-grid">
            {cells.map((day, i) => {
              if (day === null) return <span key={i} className="dp-cell empty" />;
              const key = toKey(view.y, view.m, day);
              const isDisabled = min ? key < min : false;
              return (
                <button
                  key={i}
                  type="button"
                  className={
                    "dp-cell" +
                    (key === value ? " selected" : "") +
                    (key === todayKey ? " today" : "")
                  }
                  disabled={isDisabled}
                  onClick={() => pick(day)}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="dp-foot">
            <button
              type="button"
              className="dp-clear"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="dp-today"
              disabled={min ? todayKey < min : false}
              onClick={() => {
                onChange(todayKey);
                setOpen(false);
              }}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
