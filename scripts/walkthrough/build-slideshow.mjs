#!/usr/bin/env node
/**
 * Build the e2e-walkthrough tutorial and run-report slideshows from a run's evidence
 * directory (Issue #829). Argv glue only; every decision lives in
 * `scripts/lib/walkthrough-slideshow-core.mjs`.
 *
 * Usage:
 *   node scripts/walkthrough/build-slideshow.mjs --in <evidence-dir> --out <dir> \
 *     --deck tutorial|report|both [--title <text>] [--inline-images]
 *
 * Exit codes: 0 built, 1 invalid manifest or screenshot, 2 bad arguments.
 */

import { runCli } from "../lib/walkthrough-slideshow-core.mjs";

process.exitCode = runCli(process.argv.slice(2), {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
});
