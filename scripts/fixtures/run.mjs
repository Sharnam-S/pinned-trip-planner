/**
 * Planner fixture suite — the regression net for persona and tool changes.
 *
 * Every behavioural rule this agent follows lives in a prompt or a zod schema,
 * and until now none of them had a test. A live review of nine trips found the
 * cost of that: conversations that ended with no itinerary at all, a tool error
 * that destroyed a chat, and rules (one write per turn) that were simply not
 * being followed. All of those are invisible to `tsc` and to `next build`.
 *
 * So this drives the REAL client — a headless browser against a real dev server
 * and a real model — through scripted journeys on the committed sample maps, and
 * asserts on what the traveler ends up with. Sample maps rather than fresh
 * builds on purpose: it makes the suite independent of YouTube's availability,
 * which is the flakiest thing in the pipeline.
 *
 * Usage:
 *   PORT=3010 npm run dev &                     # needs ANTHROPIC_API_KEY
 *   npx playwright install chromium             # once, out of tree
 *   node scripts/fixtures/run.mjs               # all scenarios
 *   node scripts/fixtures/run.mjs tbilisi-weekend
 *
 * Exit code is 0 only if every assertion passes. Costs real model tokens
 * (~$0.30-1.00 per scenario), so it belongs on a nightly run and a manual
 * trigger for persona PRs — not on every push.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Playwright is deliberately NOT a dependency of this app — it would ship a
// browser download into every install for a script most people never run.
// Resolve it from wherever it lives instead, and say so plainly if it doesn't.
const { chromium } = await import(
  process.env.PLAYWRIGHT_PATH ?? "playwright"
).catch(() => {
  console.error(
    "This suite needs Playwright, which isn't a project dependency.\n" +
      "  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright\n" +
      "  npx playwright install chromium\n" +
      "  PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright/index.mjs npm run test:fixtures"
  );
  process.exit(2);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? `http://localhost:${process.env.PORT ?? 3010}`;
const OUT = process.env.FIXTURE_OUT ?? path.join(HERE, ".out");

const scenarios = JSON.parse(
  fs.readFileSync(path.join(HERE, "scenarios.json"), "utf8")
);
const only = process.argv.slice(2);
const selected = only.length
  ? scenarios.filter((s) => only.includes(s.name))
  : scenarios;

if (selected.length === 0) {
  console.error(
    `No scenario matched ${only.join(", ")}. Available: ${scenarios
      .map((s) => s.name)
      .join(", ")}`
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A day heading in an assistant reply — the signature of a summary document.
 *  Same shape the client uses to decide when to force a commit. */
const DAY_STRUCTURE_RE = /(^|\n)\s*(#{1,3}\s*)?\**\s*day\s*\d/i;

// --- assertions ------------------------------------------------------------

/** Every check is (name, fn) → string|null. A returned string is the failure. */
function assertions(scenario, result) {
  const { trip, turns, transcript } = result;
  const plans = trip.itineraries ?? [];
  const spotsById = new Map((trip.spots ?? []).map((s) => [s.id, s]));
  const stops = plans.flatMap((p) => (p.days ?? []).flatMap((d) => d.stops ?? []));

  return [
    // The product's whole job. Two of four journeys in the review ended here.
    [
      "produces an itinerary",
      () => (plans.length > 0 ? null : "the conversation ended with no plan at all"),
    ],
    [
      "commits within the message budget",
      () => {
        // TWO by default, and that is the intended design, not a concession:
        // the agent sketches the shape, the traveler reacts, THEN the pins land
        // (persona §PLAN IN TWO STEPS). Rearranging a paragraph is cheap;
        // rearranging thirty placed pins is not. A scenario that asks to compare
        // several shapes first can declare a larger budget.
        const budget = scenario.maxMessagesToCommit ?? 2;
        return result.messagesBeforeFirstPlan <= budget
          ? null
          : `took ${result.messagesBeforeFirstPlan} user messages to commit a plan (want <= ${budget})`;
      },
    ],
    [
      "at most one shape revision",
      () => {
        // The shape step is bounded, not unlimited. One summary, one revision if
        // their reply changes the shape, then it commits. Unbounded re-shaping
        // is what produced four-message conversations with an empty map.
        const budget = scenario.maxShapeDocuments ?? 2;
        return result.shapeDocuments <= budget
          ? null
          : `wrote ${result.shapeDocuments} summary documents before committing (want <= ${budget})`;
      },
    ],

    // §4.1 — the fields that only hold because the schema requires them.
    [
      "every stop has a time",
      () => failIf(stops.filter((s) => !s.time).length, "stops with no arrival time"),
    ],
    [
      "every stop has a duration",
      () => failIf(stops.filter((s) => !s.durationMin).length, "stops with no duration"),
    ],
    [
      "every stop explains itself",
      () =>
        failIf(
          stops.filter((s) => !s.why || s.why.trim().length < 20).length,
          "stops with a missing or one-word why"
        ),
    ],
    [
      "every day has a rationale",
      () =>
        failIf(
          plans.flatMap((p) => p.days ?? []).filter((d) => !d.rationale).length,
          "days with no rationale"
        ),
    ],
    [
      "day themes are experiential",
      () =>
        failIf(
          plans
            .flatMap((p) => p.days ?? [])
            .filter((d) => (d.theme ?? "").includes("+")).length,
          'themes that join spot names with "+"'
        ),
    ],

    // MEAL LOGIC — the rule is "nobody eats two meals back-to-back", and it takes
    // BOTH conditions to break it: the food stops must be adjacent in the day's
    // order AND close on the clock. Breakfast → afternoon coffee → dinner is
    // three food stops in one day and entirely correct; so is coffee at 15:30,
    // a beach walk, then dinner at 17:30. Only a genuine stack is a failure.
    [
      "no two meals stacked together",
      () => {
        const bad = [];
        for (const p of plans) {
          for (const d of p.days ?? []) {
            const seq = (d.stops ?? []).map((s) => ({
              ...s,
              cat: spotsById.get(s.spotId)?.category,
            }));
            for (let i = 1; i < seq.length; i++) {
              if (seq[i].cat !== "food" || seq[i - 1].cat !== "food") continue;
              const gap = minutesBetween(seq[i - 1].time, seq[i].time);
              if (gap !== null && gap < 90) {
                bad.push(`${d.label}: ${seq[i - 1].time} → ${seq[i].time}`);
              }
            }
          }
        }
        return bad.length
          ? `back-to-back food stops <90min apart: ${bad.join("; ")}`
          : null;
      },
    ],

    // DAY-OF-WEEK AWARENESS — a dated day must name the real weekday.
    [
      "weekday labels match the calendar",
      () => {
        const bad = [];
        for (const p of plans) {
          for (const d of p.days ?? []) {
            if (!d.date) continue;
            const real = new Date(`${d.date}T00:00:00Z`).toUTCString().slice(0, 3);
            const claimed = (d.label ?? "").match(
              /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i
            );
            if (claimed && claimed[1].toLowerCase() !== real.toLowerCase()) {
              bad.push(`${d.label} is actually a ${real}`);
            }
          }
        }
        return bad.length ? bad.join("; ") : null;
      },
    ],

    // Pace has to mean something — it's the one dial the intake exposes.
    [
      "pace matches what was asked for",
      () => {
        if (!scenario.expectPace) return null;
        const [lo, hi] = scenario.expectPace;
        const bad = plans
          .map((p) => ({
            id: p.id,
            perDay:
              (p.days ?? []).reduce((n, d) => n + (d.stops ?? []).length, 0) /
              Math.max(1, (p.days ?? []).length),
          }))
          .filter((p) => p.perDay < lo || p.perDay > hi);
        return bad.length
          ? bad
              .map((p) => `${p.id} averages ${p.perDay.toFixed(1)} stops/day (want ${lo}-${hi})`)
              .join("; ")
          : null;
      },
    ],

    // Turn budget. maxDuration is 300s, so anything close is a production
    // timeout waiting to happen.
    [
      "no turn approaches the route's ceiling",
      () => {
        const slow = turns.filter((t) => t.seconds > 240);
        return slow.length
          ? `turns over 240s: ${slow.map((t) => `#${t.n} ${t.seconds}s`).join(", ")}`
          : null;
      },
    ],
    [
      "one write per option per turn",
      () => {
        const bad = turns.filter((t) => t.duplicateWrite);
        return bad.length
          ? `turns writing the same option twice: ${bad.map((t) => `#${t.n}`).join(", ")}`
          : null;
      },
    ],

    // Nothing internal ever reaches a traveler.
    [
      "no internal error text is rendered",
      () => {
        const leaks = [
          /toolu_[A-Za-z0-9]+/,
          /AI_[A-Za-z]*Error/,
          /Tool result is missing/,
        ]
          .map((re) => transcript.match(re)?.[0])
          .filter(Boolean);
        return leaks.length ? `leaked: ${leaks.join(", ")}` : null;
      },
    ],

    // Must-sees are non-negotiable, so a starred spot must be placed.
    [
      "starred must-sees are in the plan",
      () => {
        if (!scenario.mustSeeNames?.length || plans.length === 0) return null;
        const planned = new Set(stops.map((s) => s.spotId));
        const missing = scenario.mustSeeNames.filter((name) => {
          const spot = (trip.spots ?? []).find((s) =>
            s.name.toLowerCase().includes(name.toLowerCase())
          );
          return spot && !planned.has(spot.id);
        });
        return missing.length ? `not placed: ${missing.join(", ")}` : null;
      },
    ],
  ];
}

function failIf(count, label) {
  return count > 0 ? `${count} ${label}` : null;
}

function minutesBetween(a, b) {
  const parse = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const x = parse(a);
  const y = parse(b);
  return x === null || y === null ? null : y - x;
}

// --- driver ----------------------------------------------------------------

async function runScenario(scenario) {
  const dir = path.join(OUT, scenario.name);
  fs.mkdirSync(dir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const turns = [];

  try {
    await page.goto(`${BASE}/api/auth/login?next=/`, {
      waitUntil: "domcontentloaded",
    });

    // Clone a committed sample into this account under a fresh id, carrying the
    // scenario's dates and interests so the planner sees a real trip query.
    const tripId = await page.evaluate(
      async ({ sampleId, query }) => {
        const trip = await fetch(`/api/trips/${sampleId}`).then((r) => r.json());
        const id = Array.from(crypto.getRandomValues(new Uint8Array(6)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        trip.id = id;
        trip.createdAt = new Date().toISOString();
        trip.query = { ...(trip.query ?? {}), ...query };
        delete trip.itinerary;
        delete trip.itineraries;
        const res = await fetch(`/api/trips/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trip),
        });
        if (!res.ok) throw new Error(`seed failed: ${res.status}`);
        return id;
      },
      { sampleId: scenario.sampleId, query: scenario.query }
    );

    await page.goto(`${BASE}/trip/${tripId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".planner-panel", { timeout: 60_000 });
    await sleep(2000);

    await answerIntake(page, scenario);
    await settle(page, 300);

    // A "summary document" is a day-by-day reply with no plan committed in the
    // same turn — the shape step. Counted so the suite can tell a bounded shape
    // step (good, intended) from unbounded re-proposing (the failure mode).
    // Title AND meta: the meta is what distinguishes a full rewrite from a
    // patch ("2 days updated · 10 days · …"), and only repeated full rewrites
    // are the problem.
    const planCards = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".pm-event-body")].map((n) => ({
          title: n.querySelector(".pm-event-title")?.textContent ?? "",
          meta: n.querySelector(".pm-event-meta")?.textContent ?? "",
        }))
      );

    const readTranscript = () =>
      page.evaluate(
        () => document.querySelector(".planner-scroll")?.textContent ?? ""
      );
    let shapeDocuments = 0;
    let seenText = "";
    const noteShape = async (cardsBefore) => {
      const after = await readTranscript();
      const fresh = after.length > seenText.length ? after.slice(seenText.length) : after;
      seenText = after;
      const cardsAfter = (await planCards()).length;
      if (cardsAfter === cardsBefore && DAY_STRUCTURE_RE.test(fresh)) {
        shapeDocuments++;
      }
    };
    await noteShape(0); // the opening shape, in reply to intake

    let messagesSent = 0;
    let messagesBeforeFirstPlan = Infinity;
    for (const message of scenario.messages) {
      const text = typeof message === "string" ? message : message.text;
      const cardsBefore = (await planCards()).length;
      const before = Date.now();
      await sendComposer(page, text);
      messagesSent++;
      await sleep(1500);
      await settle(page, message.timeout ?? 420);

      await noteShape(cardsBefore);
      // Only the cards this turn produced — earlier turns' cards stay in the
      // thread, and counting those would flag every conversation after the first.
      const writes = (await planCards()).slice(cardsBefore);
      turns.push({
        n: messagesSent,
        seconds: Math.round((Date.now() - before) / 1000),
        // Two "wrote a plan" cards naming the same option in one turn is the
        // habit B2's patch mode exists to remove.
        duplicateWrite: hasDuplicateOptionWrite(writes),
      });

      if (messagesBeforeFirstPlan === Infinity) {
        const has = await page.evaluate(
          (id) =>
            fetch(`/api/trips/${id}`)
              .then((r) => r.json())
              .then((t) => (t.itineraries ?? []).length > 0),
          tripId
        );
        if (has) messagesBeforeFirstPlan = messagesSent;
      }
    }

    const trip = await page.evaluate(
      (id) => fetch(`/api/trips/${id}`).then((r) => r.json()),
      tripId
    );
    const transcript = await page.evaluate(
      () => document.querySelector(".planner-scroll")?.textContent ?? ""
    );
    await page.screenshot({ path: path.join(dir, "final.png") });
    fs.writeFileSync(
      path.join(dir, "trip.json"),
      JSON.stringify(trip, null, 2)
    );

    return {
      trip,
      turns,
      shapeDocuments,
      transcript,
      messagesBeforeFirstPlan:
        messagesBeforeFirstPlan === Infinity
          ? messagesSent + 1
          : messagesBeforeFirstPlan,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Two FULL REWRITES of the same option within one turn — the expensive habit.
 *
 * A rewrite followed by a patch is the behaviour we want: commit the plan, then
 * refine a day cheaply. Counting every write would flag that as a regression,
 * which is how a good test talks a team out of a good change.
 */
function hasDuplicateOptionWrite(cards) {
  const rewritten = new Set();
  for (const card of cards) {
    const isPatch = /\bupdated ·/.test(card.meta);
    if (isPatch) continue;
    const title = card.title.split("Option")[0]?.trim();
    if (!title) continue;
    if (rewritten.has(title)) return true;
    rewritten.add(title);
  }
  return false;
}

async function answerIntake(page, scenario) {
  for (let i = 0; i < 12; i++) {
    const question = await page.evaluate(() => {
      const turns = [...document.querySelectorAll(".ci-turn")];
      const last = turns[turns.length - 1];
      if (!last || last.querySelector(".ci-a")) return null;
      return {
        prompt: last.querySelector(".ci-q")?.textContent ?? "",
        options: [...last.querySelectorAll(".ci-chips .suggestion-chip")].map(
          (b) => b.textContent ?? ""
        ),
      };
    });
    if (!question) {
      await sleep(1200);
      if (!(await page.$(".ci-chips")) || (await page.$(".pm-typing"))) return;
      continue;
    }
    const rule = (scenario.intake ?? []).find((r) =>
      r.match.some((m) => question.prompt.toLowerCase().includes(m.toLowerCase()))
    );
    const chip = rule?.chips
      ?.map((c) => question.options.find((o) => o.toLowerCase().includes(c.toLowerCase())))
      .filter(Boolean)[0];
    if (chip) {
      await page.getByRole("button", { name: chip, exact: true }).first().click();
      // Multi-select questions (the must-see picker) don't advance on a tap —
      // they wait for "That's it →". Without this the loop re-taps the same
      // chip, toggling it off, and the intake never finishes.
      const confirm = await page.$(".ci-done");
      if (confirm) await confirm.click();
    } else {
      await sendComposer(page, rule?.text ?? "no preference");
    }
    await sleep(1500);
  }
}

/** Type and send, waiting for the panel to be idle first. The send button is
 *  disabled while the agent is streaming, so clicking blind turns a slow turn
 *  into a crashed fixture — which says nothing about the product. */
async function sendComposer(page, text) {
  // A turn is not one request: a tool call is answered client-side and the SDK
  // auto-sends the follow-up round, and the gap between them can outlast the
  // idle window. So a "settled" panel can go busy again a second later, and a
  // blind click lands on a disabled button and hangs. Settle, try, re-settle.
  for (let attempt = 0; attempt < 4; attempt++) {
    await settle(page, 300);
    await page.fill(".planner-inputrow textarea", text);
    try {
      await page
        .locator('.planner-inputrow button[type="submit"]')
        .click({ timeout: 15_000 });
      return;
    } catch {
      // Went busy again mid-click — wait it out and retry.
    }
  }
  throw new Error(`composer never became sendable for: ${text.slice(0, 40)}…`);
}

/** Busy is `.pm-typing`; settled means it's been gone for 4 straight seconds. */
async function settle(page, maxSeconds) {
  const end = Date.now() + maxSeconds * 1000;
  let quiet = 0;
  while (Date.now() < end) {
    let busy;
    try {
      // `locator().count()` rather than `page.$` — an element handle taken while
      // the page is mid-navigation can't be adopted afterwards, which crashed a
      // whole scenario ("Unable to adopt element handle from a different
      // document") for a reason that had nothing to do with the product.
      busy = (await page.locator(".pm-typing").count()) > 0;
    } catch {
      // Navigating or re-rendering — treat as busy and look again.
      busy = true;
    }
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 4) return true;
    await sleep(1000);
  }
  return false;
}

// --- main ------------------------------------------------------------------

let failed = 0;
for (const scenario of selected) {
  process.stdout.write(`\n▶ ${scenario.name}\n`);
  let result;
  try {
    result = await runScenario(scenario);
  } catch (err) {
    console.log(`  ✗ scenario crashed: ${err.message}`);
    failed++;
    continue;
  }
  for (const [name, check] of assertions(scenario, result)) {
    let problem;
    try {
      problem = check();
    } catch (err) {
      problem = `check threw: ${err.message}`;
    }
    if (problem) {
      console.log(`  ✗ ${name} — ${problem}`);
      failed++;
    } else {
      console.log(`  ✓ ${name}`);
    }
  }
  console.log(
    `  · ${result.turns.map((t) => `${t.seconds}s`).join(" / ")} · ${
      (result.trip.itineraries ?? []).length
    } option(s)`
  );
}

console.log(failed === 0 ? "\nAll fixtures passed." : `\n${failed} assertion(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
