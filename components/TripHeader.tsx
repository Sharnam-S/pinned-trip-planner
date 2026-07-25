"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import MonthGrid, {
  formatDay,
  parseKey,
  thisMonth,
  type YearMonth,
} from "./MonthGrid";
import {
  PARTY_OPTIONS,
  formatDateRange,
  partyLabel,
  type TripFacets,
} from "@/lib/tripFacets";
import { ICON_NAV } from "@/lib/ui";
import type { TripParty } from "@/lib/types";

// The trip's one header, spanning the full width above the three panels: the
// place on the left, the three answers the planner needs in the middle, and
// sharing on the right. Each answer is a pill that reads as filled-in or
// still-empty, and opens its own small editor — the same popover language as
// the date picker, so nothing new to learn.

const INTEREST_IDEAS = [
  "Food",
  "Surfing",
  "Nightlife",
  "Nature",
  "Culture",
  "Wellness",
  "Shopping",
];

function IconCalendar() {
  return (
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconSparkle() {
  return (
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPeople() {
  return (
    <svg width={ICON_NAV} height={ICON_NAV} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 19c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 5.6a3.2 3.2 0 010 4.9M17.5 14.6c2 .5 3.5 2.1 3.5 4.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** A header pill plus its popover editor. `value` present = answered. */
function Facet({
  icon,
  value,
  placeholder,
  dialogLabel,
  children,
}: {
  icon: ReactNode;
  value: string | null;
  placeholder: string;
  dialogLabel: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside press or Escape. `pointerdown` so a press outside
  // dismisses before it lands on whatever is underneath; the date picker's own
  // popover is inside rootRef, so picking a day doesn't close this.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="facet" ref={rootRef}>
      <button
        type="button"
        className={`facet-pill${value ? " set" : ""}${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="facet-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="facet-value">{value ?? placeholder}</span>
      </button>
      {open && (
        <div className="facet-pop" role="dialog" aria-label={dialogLabel}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Start and end in one calendar: the two ends are segments, the grid fills
 *  whichever is armed, and picking a start arms the end. One grid rather than
 *  two nested pickers — a calendar popping out of a popover covered the popover
 *  it came from. */
function DatesEditor({
  startDate,
  endDate,
  onChange,
  close,
}: {
  startDate?: string;
  endDate?: string;
  onChange: (patch: { startDate?: string; endDate?: string }) => void;
  close: () => void;
}) {
  // Which end the next click sets. Land on "end" when only a start exists —
  // that's the half-finished range the user came back to complete.
  const [arm, setArm] = useState<"start" | "end">(
    startDate && !endDate ? "end" : "start"
  );
  const [view, setView] = useState<YearMonth>(() => {
    const at = parseKey(startDate ?? "") ?? parseKey(endDate ?? "");
    return at ? { y: at.y, m: at.m } : thisMonth();
  });

  const pick = (key: string) => {
    if (arm === "start") {
      // A start past the current end would invert the range — drop the end.
      onChange({
        startDate: key,
        endDate: endDate && key > endDate ? undefined : endDate,
      });
      setArm("end");
      return;
    }
    // Picking an "end" before the start means they meant a new, earlier start.
    if (startDate && key < startDate) {
      onChange({ startDate: key, endDate: startDate });
    } else {
      onChange({ endDate: key });
    }
    setArm("start");
  };

  return (
    <>
      <div className="facet-range">
        {(
          [
            ["start", "From", startDate],
            ["end", "To", endDate],
          ] as const
        ).map(([which, label, value]) => (
          <button
            type="button"
            key={which}
            className={`facet-end${arm === which ? " armed" : ""}`}
            onClick={() => setArm(which)}
          >
            <span className="facet-end-label">{label}</span>
            <span className={`facet-end-value${value ? "" : " empty"}`}>
              {(value && formatDay(value)) ?? "Add date"}
            </span>
          </button>
        ))}
      </div>

      <MonthGrid
        view={view}
        onView={setView}
        ends={[startDate, endDate]}
        // Only the end is constrained; re-picking a start should be free.
        min={arm === "end" ? startDate : undefined}
        onPick={pick}
      />

      <div className="facet-pop-foot">
        <button
          type="button"
          className="facet-clear"
          onClick={() => {
            onChange({ startDate: undefined, endDate: undefined });
            setArm("start");
          }}
        >
          Clear
        </button>
        <button type="button" className="facet-done" onClick={close}>
          Done
        </button>
      </div>
    </>
  );
}

/** Free text, with a few one-tap ideas that append to (or remove from) it. */
function InterestsEditor({
  value,
  onChange,
  close,
}: {
  value: string;
  onChange: (next: string) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const parts = draft
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const commit = (next: string) => {
    setDraft(next);
    onChange(next);
  };

  const toggle = (idea: string) => {
    const has = parts.some((p) => p.toLowerCase() === idea.toLowerCase());
    const next = has
      ? parts.filter((p) => p.toLowerCase() !== idea.toLowerCase())
      : [...parts, idea.toLowerCase()];
    commit(next.join(", "));
  };

  return (
    <>
      <span className="facet-pop-label">What are you into?</span>
      <input
        className="facet-input"
        type="text"
        value={draft}
        autoFocus
        placeholder="Surfing, street food…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onChange(draft);
            close();
          }
        }}
      />
      <div className="facet-ideas">
        {INTEREST_IDEAS.map((idea) => {
          const on = parts.some((p) => p.toLowerCase() === idea.toLowerCase());
          return (
            <button
              type="button"
              key={idea}
              className={`facet-idea${on ? " on" : ""}`}
              aria-pressed={on}
              onClick={() => toggle(idea)}
            >
              {idea}
            </button>
          );
        })}
      </div>
      <div className="facet-pop-foot">
        <button type="button" className="facet-clear" onClick={() => commit("")}>
          Clear
        </button>
        <button
          type="button"
          className="facet-done"
          onClick={() => {
            onChange(draft);
            close();
          }}
        >
          Done
        </button>
      </div>
    </>
  );
}

export default function TripHeader({
  name,
  facets,
  onChange,
  action,
}: {
  name: string;
  facets: TripFacets;
  onChange: (patch: Partial<TripFacets>) => void;
  /** Share control — the header's rightmost slot. */
  action?: ReactNode;
}) {
  const dates = formatDateRange(facets.startDate, facets.endDate);
  const party = partyLabel(facets.party);

  return (
    <header className="trip-header">
      <h1 className="trip-header-name">{name}</h1>

      <div className="trip-facets">
        <Facet
          icon={<IconCalendar />}
          value={dates}
          placeholder="Add dates"
          dialogLabel="Trip dates"
        >
          {(close) => (
            <DatesEditor
              startDate={facets.startDate}
              endDate={facets.endDate}
              onChange={onChange}
              close={close}
            />
          )}
        </Facet>

        <Facet
          icon={<IconSparkle />}
          value={facets.interests?.trim() ? facets.interests : null}
          placeholder="Add interests"
          dialogLabel="Trip interests"
        >
          {(close) => (
            <InterestsEditor
              value={facets.interests ?? ""}
              onChange={(next) =>
                onChange({ interests: next.trim() || undefined })
              }
              close={close}
            />
          )}
        </Facet>

        <Facet
          icon={<IconPeople />}
          value={party}
          placeholder="Who's going?"
          dialogLabel="Who's going"
        >
          {(close) => (
            <>
              <span className="facet-pop-label">Who&rsquo;s going?</span>
              <div className="facet-options">
                {PARTY_OPTIONS.map((o) => (
                  <button
                    type="button"
                    key={o.value}
                    className={`facet-option${facets.party === o.value ? " on" : ""}`}
                    aria-pressed={facets.party === o.value}
                    onClick={() => {
                      onChange({
                        party:
                          facets.party === o.value
                            ? undefined
                            : (o.value as TripParty),
                      });
                      close();
                    }}
                  >
                    <span aria-hidden="true">{o.emoji}</span>
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </Facet>
      </div>

      <div className="trip-header-actions">{action}</div>
    </header>
  );
}
