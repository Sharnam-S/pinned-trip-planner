"use client";

import { ReactNode, useEffect, useRef, useState } from "react";

export type SheetSnap = "peek" | "half" | "full";

// px of sheet visible at "peek": grip + tab row, nothing else.
const PEEK_PX = 104;
// Gap left above the sheet at "full" so the map still peeks through.
const FULL_TOP_GAP = 48;
// How far ahead (ms) a release flick is projected when picking the snap.
const FLING_MS = 160;

function snapHeights(): Record<SheetSnap, number> {
  const vh = window.innerHeight;
  return {
    peek: PEEK_PX,
    half: Math.round(vh * 0.5),
    full: vh - FULL_TOP_GAP,
  };
}

/**
 * The mobile trip page's bottom sheet: three snap heights (peek / half /
 * full), Airbnb style, floating over the fullscreen map. Dragging lives on
 * the header zone (grip + tabs) so the content area keeps native scrolling;
 * the height is driven in px (not CSS classes) so a release animates from
 * exactly where the finger let go. Focusing any input inside expands to
 * full — the on-screen keyboard would otherwise cover a half-height sheet.
 */
export default function BottomSheet({
  snap,
  onSnapChange,
  header,
  children,
}: {
  snap: SheetSnap;
  onSnapChange: (s: SheetSnap) => void;
  header: ReactNode;
  children: ReactNode;
}) {
  // null until mounted — the CSS default height covers the first paint.
  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // True while a pointerdown from the header is live (window listeners on).
  const activeDragRef = useRef(false);
  // Set once a real drag happened, so the click that follows pointerup
  // doesn't also fire a tab switch / peek-expand.
  const suppressClickRef = useRef(false);

  // Track the snap height through viewport changes too (URL bar collapsing,
  // rotation, Android keyboard).
  useEffect(() => {
    const apply = () => setHeight(snapHeights()[snap]);
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [snap]);

  // Drag via window listeners (same pattern as the desktop rail resizer):
  // dragging up immediately leaves the header for the map above it, and mouse
  // pointers — unlike touch — get no implicit capture, so element-scoped
  // move/up handlers would lose the gesture right away. Explicit capture
  // isn't an option either: it retargets the tap's click at the container,
  // swallowing the tab buttons.
  const onPointerDown = (e: React.PointerEvent) => {
    if (activeDragRef.current) return; // second finger — ignore
    activeDragRef.current = true;
    suppressClickRef.current = false;
    const startY = e.clientY;
    const startH = height ?? snapHeights()[snap];
    // Last two samples, for release velocity.
    let lastY = startY;
    let lastT = e.timeStamp;
    let prevY = lastY;
    let prevT = lastT;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      // Small threshold so taps on the tab buttons stay taps.
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) {
        moved = true;
        suppressClickRef.current = true;
        setDragging(true);
      }
      prevY = lastY;
      prevT = lastT;
      lastY = ev.clientY;
      lastT = ev.timeStamp;
      const h = snapHeights();
      setHeight(Math.min(h.full, Math.max(h.peek, startH - dy)));
    };

    const onUp = (ev: PointerEvent) => {
      activeDragRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) return;
      setDragging(false);
      const h = snapHeights();
      const cur = Math.min(
        h.full,
        Math.max(h.peek, startH - (ev.clientY - startY))
      );
      // Project the flick a beat forward so a quick swipe crosses to the
      // next snap even if the finger only travelled a short distance.
      const v = (lastY - prevY) / Math.max(1, lastT - prevT); // px/ms, + = down
      const projected = cur - v * FLING_MS;
      const target = (Object.keys(h) as SheetSnap[]).reduce((best, s) =>
        Math.abs(h[s] - projected) < Math.abs(h[best] - projected) ? s : best
      );
      setHeight(h[target]);
      if (target !== snap) onSnapChange(target);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className={`sheet ${dragging ? "dragging" : ""}`}
      style={height != null ? { height } : undefined}
      // The trip page clears transient state (search dropdown, pinned video)
      // on any outside click — the sheet is "inside".
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="sheet-drag"
        onPointerDown={onPointerDown}
        onClickCapture={(e) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        // A plain tap on the collapsed bar opens the sheet (tab taps land
        // here too via bubbling — switching and expanding at once).
        onClick={() => {
          if (snap === "peek") onSnapChange("half");
        }}
      >
        <div className="sheet-grip" aria-hidden="true" />
        {header}
      </div>
      <div
        className="sheet-body"
        onFocusCapture={(e) => {
          const tag = (e.target as HTMLElement).tagName;
          if (snap !== "full" && (tag === "TEXTAREA" || tag === "INPUT")) {
            onSnapChange("full");
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
