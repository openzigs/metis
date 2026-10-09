#!/usr/bin/env node
/**
 * Fill the walkthrough's wave briefs from a per-run state file and the reviewed `fixes.json`
 * (#954). Writes nothing when a placeholder is left unfilled, a relevant PR is unplaced, or a
 * required PR is missing from the fixes list.
 *
 * Argv glue only; the decisions live in `scripts/lib/walkthrough-fill-brief-core.mjs`.
 *
 * Usage:
 *   node scripts/walkthrough/fill-brief.mjs --state <run>/state.json --fixes <run>/fixes.json \
 *     --out <run>/briefs [--briefs .github/skills/e2e-walkthrough/briefs]
 *
 * Exit codes: 0 written, 1 refused, 2 bad arguments.
 */

import fs from "node:fs";

import { runFillBrief } from "../lib/walkthrough-fill-brief-core.mjs";

process.exitCode = runFillBrief(process.argv.slice(2), {
  readFile: (file) => fs.readFileSync(file, "utf8"),
  listDir: (dir) => fs.readdirSync(dir),
  writeFile: (file, text) => fs.writeFileSync(file, text),
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
});
