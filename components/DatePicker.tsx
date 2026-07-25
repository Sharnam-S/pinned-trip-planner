"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/lib/useIsMobile";
import MonthGrid, {
  parseKey,
  thisMonth,
  todayKey,
  type YearMonth,
} from "./MonthGrid";

// A calendar date picker that matches the landing page's sky/blue design —
// replaces the browser's unstyleable native `<input type="date">` popup.
// Dates are plain `yyyy-mm-dd` strings, parsed and formatted in local time so
// there's no timezone drift (never `new Date("2026-07-17")`, which is UTC).
//
// On phones the same calendar opens as a bottom sheet portaled to <body>
// instead of a popover anchored to the trigger: the trigger is only half a
// row wide inside the "When" field, so an anchored popover collapsed to ~110px
// (unreadable grid) and got clipped by the landing card's stacking context.

type Props = {
  label: string;
  value: string; // yyyy-mm-dd, or "" when unset
  onChange: (value: string) => void;
  min?: string; // yyyy-mm-dd — days before this are disabled
  disabled?: boolean;
  placeholder?: string;
};

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
  const isMobile = useIsMobile();

  const selected = parseKey(value);

  // Where the grid lands when nothing is selected: the `min` month (so the
  // "To" field opens near the chosen "From" date) falling back to today.
  const fallbackView = (): YearMonth => {
    const m = parseKey(min ?? "");
    return m ? { y: m.y, m: m.m } : thisMonth();
  };

  // The month the grid is currently showing.
  const [view, setView] = useState<YearMonth>(() => selected ?? fallbackView());

  // When the field opens, jump the grid to the selected date (or the fallback).
  useEffect(() => {
    if (!open) return;
    const s = parseKey(value);
    setView(s ? { y: s.y, m: s.m } : fallbackView());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Flip the popup above the field when there isn't room below it. The sheet
  // is bottom-anchored, so this only matters on desktop.
  useLayoutEffect(() => {
    if (!open || isMobile || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setDropUp(window.innerHeight - rect.bottom < 360);
  }, [open, isMobile]);

  // Close on outside press or Escape. `pointerdown` (not `mousedown`) so a
  // touch outside dismisses immediately, and the sheet is checked separately
  // because the portal puts it outside `rootRef`.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
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

  // Freeze the page behind the sheet so scrolling the calendar can't drag the
  // landing page around underneath it.
  useEffect(() => {
    if (!open || !isMobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, isMobile]);

  const today = todayKey();

  const display = selected
    ? new Date(selected.y, selected.m - 1, selected.d).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  const calendar = (
    <>
      <MonthGrid
        view={view}
        onView={setView}
        ends={[value]}
        min={min}
        onPick={(key) => {
          onChange(key);
          setOpen(false);
        }}
      />

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
          disabled={min ? today < min : false}
          onClick={() => {
            onChange(today);
            setOpen(false);
          }}
        >
          Today
        </button>
      </div>
    </>
  );

  const dialogLabel = `Choose ${label || placeholder} date`;

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

      {open && !isMobile && (
        <div
          className={`dp-pop${dropUp ? " up" : ""}`}
          role="dialog"
          aria-label={dialogLabel}
          ref={popRef}
        >
          {calendar}
        </div>
      )}

      {open &&
        isMobile &&
        createPortal(
          <>
            <div className="dp-backdrop" onClick={() => setOpen(false)} />
            <div className="dp-sheet" role="dialog" aria-label={dialogLabel} ref={popRef}>
              <div className="dp-sheet-inner">
                <span className="dp-grab" aria-hidden="true" />
                {calendar}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
