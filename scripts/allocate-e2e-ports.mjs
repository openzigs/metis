#!/usr/bin/env node
/**
 * Allocate a per-run port pair for the Playwright e2e stack (Issue #1067).
 *
 * The self-hosted runner executes several jobs at once. Ports are
 * machine-global, so the hard-coded 4101/3101 pair in
 * `e2e/playwright.config.ts` collides whenever a sibling run is already up:
 *
 *     Error: http://127.0.0.1:4101/healthz is already used ...
 *
 * This script picks a free pair derived from `GITHUB_RUN_ID`, prints it, and
 * exports `E2E_API_PORT` / `E2E_UI_PORT` via `$GITHUB_ENV` for the steps that
 * follow. Those two variables are already honoured by
 * `e2e/playwright.config.ts` and `e2e/fixtures/api-base.ts`, so no test code
 * changes. Outside Actions it just prints the pair.
 *
 * The allocation policy lives in a pure, unit-tested module
 * (scripts/lib/e2e-ports.mjs); this file only does I/O.
 *
 * Usage:  node scripts/allocate-e2e-ports.mjs
 */
import { appendFileSync } from "node:fs";

import { allocateE2ePorts, formatGithubEnv } from "./lib/e2e-ports.mjs";

const allocation = await allocateE2ePorts();

const detail =
  allocation.skipped.length > 0
    ? ` (slot ${allocation.startSlot} was busy; skipped ${allocation.skipped.join(", ")})`
    : "";

// Printed unconditionally so the resolved ports are visible in the job log —
// this is the evidence that two concurrent runs really did get distinct ports.
console.log(
  `e2e ports: API=${allocation.apiPort} UI=${allocation.uiPort} ` +
    `[run ${process.env.GITHUB_RUN_ID ?? "local"} attempt ${process.env.GITHUB_RUN_ATTEMPT ?? "-"} ` +
    `-> slot ${allocation.slot}]${detail}`,
);

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, formatGithubEnv(allocation));
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `- e2e stack ports for this run: API \`${allocation.apiPort}\`, UI \`${allocation.uiPort}\` (slot ${allocation.slot})\n`,
  );
}
