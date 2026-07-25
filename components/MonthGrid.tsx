"use client";

// One month of days, shared by the standalone DatePicker and the trip header's
// range editor — so the two can't drift on first-weekday maths, `min` handling,
// or cell styling. Dates are plain `yyyy-mm-dd` strings parsed in local time;
// never `new Date("2026-07-17")`, which is UTC and shifts the day west of
// Greenwich.

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type YearMonth = { y: number; m: number };

/** yyyy-mm-dd -> {y, m, d} (m is 1-based), or null for empty/invalid. */
export function parseKey(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { y: +match[1], m: +match[2], d: +match[3] };
}

export function toKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function todayKey(): string {
  const t = new Date();
  return toKey(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

export function thisMonth(): YearMonth {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth() + 1 };
}

export function shiftMonth(v: YearMonth, delta: number): YearMonth {
  const idx = v.y * 12 + (v.m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/** Day formatted for a label: "Aug 3". */
export function formatDay(key: string): string | null {
  const d = parseKey(key);
  if (!d) return null;
  return new Date(d.y, d.m - 1, d.d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** Weekday index (0=Sun) of the first day of a month. */
function firstWeekday(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

export default function MonthGrid({
  view,
  onView,
  /** Days to draw as picked — one for a single date, two for a range's ends. */
  ends,
  min,
  onPick,
}: {
  view: YearMonth;
  onView: (next: YearMonth) => void;
  ends: (string | undefined)[];
  min?: string;
  onPick: (key: string) => void;
}) {
  const picked = ends.filter((e): e is string => Boolean(e));
  const [from, to] = [...picked].sort();
  const total = daysInMonth(view.y, view.m);
  const lead = firstWeekday(view.y, view.m);
  const cells: (number | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  const today = todayKey();

  return (
    <>
      <div className="dp-head">
        <div className="dp-month">
          {MONTHS[view.m - 1]} {view.y}
        </div>
        <div className="dp-nav">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => onView(shiftMonth(view, -1))}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => onView(shiftMonth(view, 1))}
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
          return (
            <button
              key={i}
              type="button"
              className={
                "dp-cell" +
                (picked.includes(key) ? " selected" : "") +
                // Only the days strictly inside a two-ended range.
                (from && to && key > from && key < to ? " in-range" : "") +
                (key === today ? " today" : "")
              }
              disabled={min ? key < min : false}
              onClick={() => onPick(key)}
            >
              {day}
            </button>
          );
        })}
      </div>
    </>
  );
}
