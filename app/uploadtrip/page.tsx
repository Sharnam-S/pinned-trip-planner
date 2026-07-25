"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trip } from "@/lib/types";
import { markOwned } from "@/lib/clientStore";
import { saveTrip } from "@/lib/tripStore";

/**
 * Share a trip JSON into the shared library. Drop in a file someone exported
 * (or paste the JSON), and it's published for everyone — and saved to this
 * browser so you can manage/delete it.
 */
export default function UploadTrip() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");

  function looksLikeTrip(t: unknown): t is Trip {
    if (!t || typeof t !== "object") return false;
    const o = t as Record<string, unknown>;
    return (
      typeof o.id === "string" &&
      typeof o.name === "string" &&
      Array.isArray(o.spots) &&
      Array.isArray(o.videos)
    );
  }

  async function readFile(file: File) {
    setText(await file.text());
  }

  async function publish() {
    setStatus("working");
    setMessage("");
    let trip: Trip;
    try {
      const parsed = JSON.parse(text);
      if (!looksLikeTrip(parsed)) throw new Error("missing trip fields");
      trip = parsed;
    } catch {
      setStatus("error");
      setMessage("That isn't a valid trip JSON file.");
      return;
    }
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trip),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      markOwned(trip.id);
      // keep a local copy too, so it's in your own gallery immediately
      await saveTrip(trip);
      router.push(`/trip/${trip.id}`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  return (
    <main className="upload-page">
      <a className="back" href="/">← Home</a>
      <h1>Share a trip</h1>
      <p className="upload-sub">
        Upload a trip JSON to add it to the shared library — anyone with the
        link will see it. Get the file from a trip&rsquo;s{" "}
        <strong>Export</strong> button, or paste the JSON below.
      </p>

      <label className="upload-drop">
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
        />
        <span>Choose a .json file</span>
      </label>

      <textarea
        className="upload-text"
        placeholder="…or paste trip JSON here"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {message && <div className="upload-msg error">{message}</div>}

      <button
        className="btn-primary"
        onClick={publish}
        disabled={status === "working" || !text.trim()}
      >
        {status === "working" ? "Publishing…" : "Publish to shared library"}
      </button>
    </main>
  );
}
