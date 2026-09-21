#!/usr/bin/env node
/**
 * Tally an adversarial review panel (Issue #1113, epic #1107).
 *
 * Reads a JSON array of per-lens verdicts — one entry per voter, as emitted by
 * `.claude/agents/adversarial-reviewer.md` — and prints the outcome. All decision logic
 * lives in `scripts/lib/adversarial-tally-core.mjs`; this file only does I/O, so the
 * arithmetic that grades the panel is unit-tested and, more importantly, is computed
 * OUTSIDE any model. A panel that grades itself is not a panel.
 *
 * Usage:
 *   pnpm review:adversarial-tally <verdicts.json>
 *   cat verdicts.json | pnpm review:adversarial-tally
 *   pnpm review:adversarial-tally <verdicts.json> --json
 *
 * Exit codes: 0 = CLEAR or ADVISORY, 1 = BLOCKED or INCOMPLETE (a panel that did not run
 * is not evidence that a change is fine), 2 = the input itself could not be read or parsed.
 */

import { readFileSync } from "node:fs";

import { exitCodeFor, formatReport, tallyPanel } from "./lib/adversarial-tally-core.mjs";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "Usage: pnpm review:adversarial-tally <verdicts.json> [--json]",
      "       cat verdicts.json | pnpm review:adversarial-tally [--json]",
      "",
      "Input is a JSON array of per-lens verdict objects from the adversarial-reviewer agent.",
      "Exit 0 = CLEAR/ADVISORY, 1 = BLOCKED/INCOMPLETE, 2 = unreadable input.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const asJson = args.includes("--json");
const file = args.find((a) => !a.startsWith("-"));

let source;
try {
  source = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
} catch (error) {
  process.stderr.write(`adversarial-tally: cannot read ${file ?? "stdin"}: ${error.message}\n`);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(source);
} catch (error) {
  process.stderr.write(`adversarial-tally: input is not valid JSON: ${error.message}\n`);
  process.exit(2);
}

const tally = tallyPanel(parsed);
process.stdout.write(asJson ? `${JSON.stringify(tally, null, 2)}\n` : `${formatReport(tally)}\n`);
process.exit(exitCodeFor(tally));
