"use client";

import { useState } from "react";
import { sortSections, topicMeta, usableBriefing } from "@/lib/briefing";
import { youtubeLink } from "@/lib/categories";
import { ICON_NAV } from "@/lib/ui";
import { track } from "@/lib/track";
import { Trip } from "@/lib/types";

/**
 * "Before you go" — what the creators said about the destination itself,
 * folded out of the same transcripts the pins came from.
 *
 * Collapsed by default and it must stay that way. This sits directly above the
 * map's pins, which are the reason the traveler opened the page; an expanded
 * block of prose there would push the thing they came for below the fold on
 * every visit for the sake of something they read once.
 */
export default function TripBriefing({ trip }: { trip: Trip }) {
  const [open, setOpen] = useState(false);
  const briefing = usableBriefing(trip);
  if (!briefing) return null;

  // `points` is required from BRIEFING_VERSION 2 on, and `usableBriefing`
  // rejects older versions — the guard is for a hand-edited or half-written
  // store, where an empty section would render as a heading over nothing.
  const sections = sortSections(briefing.sections).filter((s) => s.points?.length);
  if (sections.length === 0) return null;
  // Resolve sources against the trip's own video list rather than storing the
  // channel name on every note — same reason spot mentions don't.
  const videoById = new Map(trip.videos.map((v) => [v.id, v]));
  const contributing = new Set(sections.flatMap((s) => s.sources.map((x) => x.videoId)));

  return (
    <section className={`briefing ${open ? "open" : ""}`}>
      <button
        className="briefing-toggle"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            track("briefing_opened", {
              tripId: trip.id,
              sections: sections.length,
            });
          }
          setOpen((o) => !o);
        }}
      >
        <span className="briefing-title">Before you go</span>
        <span className="briefing-sub">
          {sections.length} thing{sections.length === 1 ? "" : "s"} to know from{" "}
          {contributing.size} video{contributing.size === 1 ? "" : "s"}
        </span>
        <svg
          className="briefing-chevron"
          width={ICON_NAV}
          height={ICON_NAV}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.5 4.5L6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="briefing-body" inert={!open}>
        {sections.map((section) => {
          const meta = topicMeta(section.topic);
          const sources = section.sources
            .map((s) => ({ ...s, video: videoById.get(s.videoId) }))
            .filter((s) => s.video);
          return (
            <div className="briefing-item" key={section.topic}>
              <div className="briefing-item-head">
                <span className="briefing-emoji" aria-hidden="true">
                  {meta.emoji}
                </span>
                <h3 className="briefing-label">{meta.label}</h3>
              </div>
              <ul className="briefing-points">
                {section.points.map((point, i) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
              {sources.length > 0 && (
                <div className="briefing-sources">
                  {sources.map((s) => (
                    <a
                      key={s.videoId}
                      className="briefing-source"
                      href={youtubeLink(s.videoId, s.timestampSec)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={s.video!.title}
                    >
                      {s.video!.channelAvatar && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={s.video!.channelAvatar} alt="" width={16} height={16} />
                      )}
                      <span>{s.video!.channelName || "Watch"}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <p className="briefing-foot">
          Pulled from what the creators said, not from a guidebook. Tap a channel
          to hear it in their video.
        </p>
      </div>
    </section>
  );
}
