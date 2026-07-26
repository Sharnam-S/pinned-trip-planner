---
name: verify
description: Run the trip planner headlessly and drive a real trip page to observe a change working. Use when verifying any change to the trip UI, the trip store, or the trip API.
---

# Verifying a change in this repo

The surface is the browser. Drive `/trip/<id>` with Playwright and screenshot
what you see — the map, the panels and the store all only exist at runtime.

## Handle

```bash
[ -d node_modules ] || npm install
[ -f .env.local ] || cp .env.example .env.local   # no keys needed to browse
PORT=3010 npm run dev -- -p 3010 > /tmp/dev3010.log 2>&1 &
# ready when this returns 200:
curl -s -o /dev/null -w '%{http_code}' http://localhost:3010/api/trips/7703a30b18a0
```

Port 3010, not 3000 — Conductor runs several workspaces at once and 3000
belongs to whoever got there first.

Playwright isn't a project dependency. Install it out-of-tree so it never
lands in `package.json`:

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright
npx playwright install chromium
```

## Sample trips (no build, no API keys)

`data/trips/*.json` are served by `GET /api/trips/<id>` and render at
`/trip/<id>` without an agent run:

| id | trip |
|---|---|
| `7703a30b18a0` | Sri Lanka, 71 spots |
| `321b79dff723` | East Coast, Sri Lanka |
| `34ca1c5a8931` | Koh Tao, Thailand |
| `373aac077066` | Tbilisi, Georgia |
| `8af9344deacf` | Hokkaido, Japan |

A sample is **not yours**: `TripView`'s `isLocal` resolves to `false`, so
edits go to localStorage overlays, not the trip. To exercise the *owned*
path (the one signed-out users get), fetch a sample's JSON, give it a new id
and seed it:

```js
localStorage.setItem("pinned.trip." + id, JSON.stringify(trip));
localStorage.setItem("pinned.trip-ids", JSON.stringify([id]));
```

Then `/trip/<id>` loads it as an editable trip. Both paths are worth driving —
they store to different places.

## Gotchas

- **Photos 404 without a Google key.** Stub the proxy or spot cards spin:
  ```js
  await ctx.route("**/api/photo**", (r) => r.fulfill({
    status: 302,
    headers: { location: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
  }));
  ```
- **Desktop vs phone are different components.** ≥ 1440×900 renders
  `TripHeader` (`.trip-header`); 390×844 renders `TripHead` inside the bottom
  sheet (`.th-name`). A header change usually has to be checked in both.
- **Leaflet has no public handle**, so assert the map didn't move by reading
  `.leaflet-map-pane`'s `style.transform` plus the `.leaflet-marker-icon`
  count before and after, rather than diffing tile pixels (tiles load async
  and will diff on their own).
- `deviceScaleFactor: 3` + a `clip` around the header gives a screenshot
  you can actually read type in.
- Give the page ~1.2s after an action before asserting — trip state writes
  through `lib/tripStore.ts` asynchronously.

## Don't

`npm run lint` has 19 pre-existing errors in `scripts/*.mts` and legacy pages.
Diff the count against `git stash` before calling any of them yours — and it
isn't verification either way.
