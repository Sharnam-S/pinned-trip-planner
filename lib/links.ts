/** Client-safe YouTube URL parsing — no youtubei.js import, so the browser
 *  bundle doesn't drag the whole InnerTube client along. */
export function parseVideoId(url: string): string | null {
  const trimmed = url.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // shorts or embed URLs
      const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    return null;
  }
  return null;
}
