"use client";

import { useEffect, useRef, useState } from "react";
import { Trip, TripVideo } from "@/lib/types";
import { Logo } from "./Logo";

/**
 * Full-page state while a trip is being built — the user's very first moment
 * inside the product, so it carries the same sky-and-clouds design as the
 * landing page and does two jobs: set expectations (this can take up to ~10
 * minutes) and narrate what's happening (curate videos → watch them → pin the
 * map) so the wait feels understood, not broken.
 */

type StepState = "done" | "active" | "todo";

function StepIcon({ state, index }: { state: StepState; index: number }) {
  if (state === "done") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M2.5 7.5L5.5 10.5L11.5 3.5"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "active") {
    return <span className="bstep-pulse" aria-hidden="true" />;
  }
  return <>{index + 1}</>;
}

// The little journey: a dotted flight arc, a plane gliding along it, and map
// pins popping up in its wake — the product's promise, played on loop.
function FlightScene() {
  return (
    <div className="flight-scene" aria-hidden="true">
      <svg viewBox="0 0 340 120" width="340" height="120" fill="none">
        <path
          className="route-line"
          d="M20 104 C 100 16, 240 16, 320 104"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="0.5 9"
        />
        {[
          { x: 105, y: 50, cls: "p1" },
          { x: 170, y: 40, cls: "p2" },
          { x: 235, y: 50, cls: "p3" },
        ].map((p) => (
          // Outer g positions the pin; inner g carries the CSS pop animation
          // (a CSS transform on the same node would override the translate).
          <g key={p.cls} transform={`translate(${p.x} ${p.y})`}>
            <g className={`scene-pin ${p.cls}`}>
              <path
                d="M0 0C-5 -6.2 -7.5 -9.4 -7.5 -12.5a7.5 7.5 0 1115 0C7.5 -9.4 5 -6.2 0 0z"
                fill="#2f6fed"
              />
              <circle cx="0" cy="-12.5" r="2.6" fill="white" />
            </g>
          </g>
        ))}
      </svg>
      <span className="scene-plane">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
          <path
            d="M21.5 12.4 3.7 4.3c-.8-.4-1.6.4-1.3 1.2l2.3 5.8c.1.3.1.6 0 .9l-2.3 5.8c-.3.8.5 1.6 1.3 1.2l17.8-8.1c.7-.3.7-1.3 0-1.6z"
            fill="#17232e"
          />
          <path d="M4.9 11.6h6.4v1.3H4.9z" fill="#e8f4fa" />
        </svg>
      </span>
    </div>
  );
}

function BuildVideoCard({ v }: { v: TripVideo }) {
  return (
    <div className="bvideo" title={v.error ?? ""}>
      {v.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="bvideo-thumb" src={v.thumbnail} alt="" />
      ) : (
        <div className="bvideo-thumb placeholder" />
      )}
      <div className="bvideo-meta">
        <div className="bvideo-title">{v.title || v.url}</div>
        <div className="bvideo-sub">
          {v.channelName || "…"}
          {v.status === "done" && v.spotCount != null && ` · ${v.spotCount} spots found`}
          {v.status === "error" && ` · ${v.error}`}
        </div>
      </div>
      <span className={`bvideo-status ${v.status}`}>
        {v.status === "done" ? (
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2.5 7.5L5.5 10.5L11.5 3.5"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : v.status === "error" ? (
          "!"
        ) : v.status === "processing" ? (
          <span className="bvideo-spin" aria-label="reading now" />
        ) : (
          // Queued is not the same as being read, and showing twenty spinners
          // for four workers is why a paused build looked like a working one.
          <span className="bvideo-queued" aria-label="queued" />
        )}
      </span>
    </div>
  );
}

/** Seconds the current step has been running, counted by ticks rather than
 *  clock arithmetic: reading a clock (or a ref) during render is impure, and
 *  writing state from an effect body is the cascade React warns about — so the
 *  only write lives in the interval callback, which is neither. The step key
 *  rides along in state, so a change reads as 0 on the very next render instead
 *  of waiting for a tick. Browsers throttle timers in hidden tabs, so this can
 *  lag while the tab is in the background; for "is this step still alive?" that
 *  is fine. */
function useStepSeconds(stepKey: string): number {
  const [tick, setTick] = useState({ key: stepKey, seconds: 0 });
  const keyRef = useRef(stepKey);
  useEffect(() => {
    keyRef.current = stepKey;
  }, [stepKey]);
  useEffect(() => {
    const t = setInterval(() => {
      setTick((prev) =>
        prev.key === keyRef.current
          ? { key: prev.key, seconds: prev.seconds + 1 }
          : { key: keyRef.current, seconds: 0 }
      );
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return tick.key === stepKey ? tick.seconds : 0;
}

/** "18s" under a minute, "2m 04s" past it — a ten-minute build shouldn't read
 *  as "612s". */
function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function BuildingScreen({
  trip,
  onRetry,
}: {
  trip: Trip;
  /** Re-runs the build in place. Most build failures are transient (YouTube
   *  throttling us, a network blip), and this screen used to offer nothing but
   *  "back to trips" — sending people to start over, straight into the same
   *  wall, with their ten-minute wait thrown away. */
  onRetry?: () => void;
}) {
  const failed = trip.status === "error";
  const [retrying, setRetrying] = useState(false);
  const readable = trip.videos.filter((v) => v.status === "done").length;
  // Stage 1 until the discover call lands videos; stage 2 while we read them.
  // Stage 3 never activates here — the first pinned spot replaces this whole
  // screen with the live map, which is exactly the reveal we want.
  const curating = trip.videos.length === 0;
  // Seconds on the CURRENT step. A long step and a dead one look identical
  // otherwise — the same reason the chat shows an elapsed counter while the
  // agent thinks. Restarts when the step changes, so it reads as "this step is
  // taking a while", not "the build has been running a while".
  const onStep = useStepSeconds(curating ? "curating" : "reading");
  const total = trip.videos.length;
  const settled = trip.videos.filter(
    (v) => v.status === "done" || v.status === "error"
  ).length;

  const steps: { title: string; desc: string; state: StepState }[] = [
    {
      title: "Curating the best videos",
      desc: "We search YouTube and hand-pick the guides worth watching — tuned to your dates and interests.",
      state: curating ? "active" : "done",
    },
    {
      title: "Watching them for you",
      desc: "We read every transcript and pull out each place the creators genuinely recommend.",
      state: curating ? "todo" : "active",
    },
    {
      title: "Pinning your map",
      desc: "Every spot lands on the map with the creator's own words and a link to the exact moment they said it.",
      state: "todo",
    },
  ];

  return (
    <div className="sky-page building-page">
      <div className="cloud-layer" aria-hidden="true">
        <div className="cloud c1" />
        <div className="cloud c2" />
        <div className="cloud c3" />
      </div>

      <nav className="top-nav">
        <a href="/">
          <Logo className="brand" />
        </a>
        <a className="nav-pill" href="/">
          ← Home
        </a>
      </nav>

      <div className="building-center">
        {failed ? (
          <>
            <h1 className="building-title">
              {readable > 0
                ? "We didn't finish this map"
                : "Couldn't build this trip"}
            </h1>
            <p className="building-sub">{trip.progress}</p>
            <div className="building-actions">
              {onRetry && (
                <button
                  className="nav-pill primary"
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true);
                    onRetry();
                  }}
                >
                  {retrying ? "Trying again…" : "↻ Try again"}
                </button>
              )}
              <a className="nav-pill" href="/">
                ← Back to trips
              </a>
            </div>
          </>
        ) : (
          <>
            <FlightScene />
            <h1 className="building-title">Building your {trip.name} map</h1>
            <p className="building-sub">
              We&rsquo;re distilling hours of footage into one map. This can
              take up to 10 minutes — the perfect moment to grab a coffee. ☕
            </p>

            <div className="building-card">
              {steps.map((s, i) => (
                <div className={`bstep ${s.state}`} key={s.title}>
                  <div className="bstep-rail">
                    <div className="bstep-icon">
                      <StepIcon state={s.state} index={i} />
                    </div>
                    {i < steps.length - 1 && <div className="bstep-line" />}
                  </div>
                  <div className="bstep-body">
                    <div className="bstep-title">
                      {s.title}
                      {/* badge only the step right after the active one */}
                      {s.state === "todo" && steps[i - 1]?.state === "active" && (
                        <span className="bstep-next">up next</span>
                      )}
                    </div>
                    <div className="bstep-desc">{s.desc}</div>
                    {s.state === "active" && trip.progress && (
                      <div className="bstep-live">
                        {trip.progress}
                        {/* Held back a few seconds so a quick step doesn't
                            flash a counter nobody needed. */}
                        {onStep >= 5 && (
                          <span className="bstep-elapsed">{formatSeconds(onStep)}</span>
                        )}
                      </div>
                    )}
                    {i === 1 && s.state === "active" && total > 0 && (
                      <div className="bstep-meter">
                        <div className="bstep-bar">
                          <div
                            className="bstep-bar-fill"
                            style={{ width: `${Math.max(4, (settled / total) * 100)}%` }}
                          />
                        </div>
                        <span className="bstep-bar-label">
                          {settled} of {total} videos
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {trip.videos.length > 0 && (
              <div className="building-videos">
                <div className="bvideos-label">Your curated lineup</div>
                {trip.videos.map((v) => (
                  <BuildVideoCard key={v.id} v={v} />
                ))}
              </div>
            )}

            <p className="building-hint">
              Keep this tab open — your map appears the moment the first spots
              are pinned, then keeps filling in live.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
