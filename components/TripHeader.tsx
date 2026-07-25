"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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


/** Who's going — one tap commits and closes, so no footer. */
function PartyEditor({
  party,
  onChange,
  close,
}: {
  party?: TripParty;
  onChange: (patch: { party?: TripParty }) => void;
  close: () => void;
}) {
  return (
    <>
      <span className="facet-pop-label">Who&rsquo;s going?</span>
      <div className="facet-options">
        {PARTY_OPTIONS.map((o) => (
          <button
            type="button"
            key={o.value}
            className={`facet-option${party === o.value ? " on" : ""}`}
            aria-pressed={party === o.value}
            onClick={() => {
              onChange({ party: party === o.value ? undefined : o.value });
              close();
            }}
          >
            <span aria-hidden="true">{o.emoji}</span>
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}

type FacetKey = "dates" | "interests" | "party";

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
  // One editor open at a time, and ONE popover for all three — switching
  // sections slides and resizes that single box instead of closing one popover
  // and opening another. `shown` lags `open` by a close so the box still has
  // content to fade out with.
  const [open, setOpen] = useState<FacetKey | null>(null);
  const [shown, setShown] = useState<FacetKey | null>(null);
  // "enter" parks the box under the pill with transitions off (opening from
  // closed shouldn't fly across the header); "move" is the switch animation.
  const [mode, setMode] = useState<"enter" | "move">("enter");
  const [geom, setGeom] = useState({ x: 0, w: 260, h: 180 });

  const rowRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pills = useRef<Partial<Record<FacetKey, HTMLButtonElement | null>>>({});

  const toggle = (key: FacetKey) => {
    if (open === key) {
      setOpen(null);
      return;
    }
    if (open === null) setMode("enter");
    setOpen(key);
    setShown(key);
  };
  const close = () => setOpen(null);

  // Park the box under the open pill at its content's natural size. Re-runs on
  // content resize (the interests chips wrap, the month grid changes height),
  // so those changes ride the same transition.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const row = rowRef.current;
    const pill = open ? pills.current[open] : null;
    if (!open || !inner || !row || !pill) return;
    const place = () => {
      const w = inner.offsetWidth;
      const h = inner.offsetHeight;
      const rowLeft = row.getBoundingClientRect().left;
      const pillRect = pill.getBoundingClientRect();
      const centered = pillRect.left - rowLeft + pillRect.width / 2 - w / 2;
      // Keep it inside the viewport: the row is only as wide as the pills, so
      // a centered box under the first or last pill can overhang the header.
      const x = Math.min(
        Math.max(centered, 12 - rowLeft),
        window.innerWidth - 12 - w - rowLeft
      );
      setGeom({ x, w, h });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(inner);
    // The row is centred in the header, so its pills move on resize without
    // changing size — which a ResizeObserver alone would never see.
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, shown]);

  // Let the parked position paint, then allow transitions so the next switch
  // animates. Two frames: one for the layout effect's styles, one to be sure
  // they're committed before the transition is armed.
  useEffect(() => {
    if (!open || mode !== "enter") return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setMode("move"));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, mode]);

  // Dismiss on outside press or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dates = formatDateRange(facets.startDate, facets.endDate);
  const interests = facets.interests?.trim() ? facets.interests : null;
  const party = partyLabel(facets.party);

  const FACETS: {
    key: FacetKey;
    icon: ReactNode;
    value: string | null;
    placeholder: string;
    label: string;
  }[] = [
    { key: "dates", icon: <IconCalendar />, value: dates, placeholder: "Add dates", label: "Trip dates" },
    { key: "interests", icon: <IconSparkle />, value: interests, placeholder: "Add interests", label: "Trip interests" },
    { key: "party", icon: <IconPeople />, value: party, placeholder: "Who's going?", label: "Who's going" },
  ];

  return (
    <header className="trip-header">
      <h1 className="trip-header-name">{name}</h1>

      <div className="trip-facets" ref={rowRef}>
        {FACETS.map((f) => (
          <button
            type="button"
            key={f.key}
            ref={(el) => {
              pills.current[f.key] = el;
            }}
            className={`facet-pill${f.value ? " set" : ""}${open === f.key ? " open" : ""}`}
            onClick={() => toggle(f.key)}
            aria-haspopup="dialog"
            aria-expanded={open === f.key}
          >
            <span className="facet-icon" aria-hidden="true">
              {f.icon}
            </span>
            <span className="facet-value">{f.value ?? f.placeholder}</span>
          </button>
        ))}

        <div
          className="facet-anchor"
          data-mode={mode}
          style={{ transform: `translateX(${geom.x}px)`, width: geom.w, height: geom.h }}
        >
          <div
            className="facet-pop"
            data-state={open ? "open" : "closed"}
            role="dialog"
            aria-label={FACETS.find((f) => f.key === shown)?.label}
            aria-hidden={!open}
            inert={!open}
          >
            {/* Keyed so switching sections mounts fresh content — it fades in
                while the box is still travelling. Absolute + max-content so
                the box measures the content, not the other way round. */}
            <div
              className="facet-pop-inner"
              data-facet={shown ?? "none"}
              key={shown ?? "none"}
              ref={innerRef}
            >
              {shown === "dates" && (
                <DatesEditor
                  startDate={facets.startDate}
                  endDate={facets.endDate}
                  onChange={onChange}
                  close={close}
                />
              )}
              {shown === "interests" && (
                <InterestsEditor
                  value={facets.interests ?? ""}
                  onChange={(next) => onChange({ interests: next.trim() || undefined })}
                  close={close}
                />
              )}
              {shown === "party" && (
                <PartyEditor party={facets.party} onChange={onChange} close={close} />
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="trip-header-actions">{action}</div>
    </header>
  );
}
