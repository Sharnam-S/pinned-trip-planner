/**
 * Read what people sent through the Feedback / "Build this" box.
 *
 * There is no admin UI and there shouldn't be one yet — but a prompt nobody
 * reads is a prompt nobody runs, and the whole point of the prompt mode is
 * that the text is meant to be handed to a coding agent more or less as
 * written. `--prompts` prints exactly that, one per block, ready to copy into
 * Conductor.
 *
 *   npx tsx scripts/read-feedback.mts                # newest 40, both kinds
 *   npx tsx scripts/read-feedback.mts --prompts      # build-this only
 *   npx tsx scripts/read-feedback.mts --limit 200
 *
 * Needs DATABASE_URL for the Neon copy; without it, it reads the local PGlite
 * store under .data/ (i.e. your own dev submissions, not production's).
 */
import { dbEnabled, listFeedback } from "../lib/db";

const args = process.argv.slice(2);
const promptsOnly = args.includes("--prompts");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) || 40 : 40;

if (!dbEnabled()) {
  console.error(
    "No database configured. Set DATABASE_URL for the production copy, or run from a checkout with a local .data/ store."
  );
  process.exit(1);
}

const rows = await listFeedback(limit);
const wanted = promptsOnly ? rows.filter((r) => r.kind === "prompt") : rows;

if (wanted.length === 0) {
  console.log(promptsOnly ? "No prompts yet." : "No feedback yet.");
  process.exit(0);
}

console.log(
  `${wanted.length} ${promptsOnly ? "prompt" : "submission"}${wanted.length === 1 ? "" : "s"}, newest first\n`
);

for (const r of wanted) {
  const who = r.contact || r.userEmail || "anonymous";
  const where = r.tripName ? ` · ${r.tripName}` : "";
  console.log("─".repeat(72));
  console.log(
    `#${r.id}  [${r.kind}]  ${r.createdAt.slice(0, 16).replace("T", " ")}  ${who}${where}`
  );
  console.log("─".repeat(72));
  console.log(r.message);
  console.log();
}
