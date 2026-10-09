#!/usr/bin/env node
/**
 * #964 — read the reports `scripts/lib/vitest-retry-reporter.mjs` wrote and flag
 * every test that passed only after a vitest retry: one GitHub annotation per
 * test, a table in the job summary, and exit 1 when the level is `error`.
 *
 *   node scripts/vitest-retried-tests.mjs <report-dir>
 *
 * Level: `VITEST_RETRY_LEVEL` (`warning` | `error`) if set, else `error` on the
 * nightly (`GITHUB_EVENT_NAME=schedule`) and `warning` everywhere else.
 *
 * A missing or empty report directory exits 2: the reporter writes a file even
 * when nothing was retried, so no file means the wiring is broken, and that must
 * not read as "nothing retried". Pure logic: `lib/vitest-retry-core.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotations,
  exitCode,
  levelFor,
  parseReports,
  summaryMarkdown,
} from "./lib/vitest-retry-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];

function fail(message) {
  console.log(`::error title=vitest retry report missing (#964)::${message}`);
  process.exit(2);
}

if (!dir) fail("usage: node scripts/vitest-retried-tests.mjs <report-dir>");
let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
} catch {
  // handled below: an unreadable directory is the same broken wiring as an empty one
}
if (files.length === 0) {
  fail(
    `No vitest retry report in ${dir}. The reporter (scripts/lib/vitest-retry-reporter.mjs) ` +
      "did not run, so retried tests cannot be checked.",
  );
}

let level;
let records;
try {
  level = levelFor(process.env.GITHUB_EVENT_NAME, process.env.VITEST_RETRY_LEVEL);
  records = parseReports(files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")));
} catch (err) {
  fail(String(err instanceof Error ? err.message : err));
}

for (const line of annotations(records, level, repoRoot)) console.log(line);
console.log(
  records.length === 0
    ? `No test passed only after a retry (${files.length} report(s) read).`
    : `${records.length} test(s) passed only after a retry (level: ${level}).`,
);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(records, level, repoRoot));
}
process.exit(exitCode(records, level));
