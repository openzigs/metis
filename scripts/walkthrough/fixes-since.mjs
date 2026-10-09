#!/usr/bin/env node
/**
 * List the fixes a walkthrough run should verify (#954): PRs merged since the previous run's
 * METIS SHA that touch what the walkthrough exercises, placed in a wave and phase by
 * `docs/walkthroughs/fix-phase-map.json`, plus everything the previous run left unconfirmed.
 * Writes a reviewable `fixes.json`, and optionally the scope comment for #706.
 *
 * Argv glue only; the decisions live in `scripts/lib/walkthrough-fixes-core.mjs` and
 * `scripts/lib/walkthrough-fixes-cli.mjs`. `git` and `gh` run with argument arrays, never
 * through a shell.
 *
 * Usage:
 *   node scripts/walkthrough/fixes-since.mjs --previous <prev>/run.json --out <run>/fixes.json \
 *     [--since <sha>] [--map <path>] [--comment <run>/scope.md --run <N>]
 *   node scripts/walkthrough/fixes-since.mjs --close-list <run>/run.json
 *
 * Exit codes: 0 done, 1 failed, 2 bad arguments.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { runFixesSince } from "../lib/walkthrough-fixes-cli.mjs";

/** @param {string} cmd @returns {(args: string[]) => string} */
const exec = (cmd) => (args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

process.exitCode = runFixesSince(process.argv.slice(2), {
  git: exec("git"),
  gh: exec("gh"),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  writeFile: (file, text) => fs.writeFileSync(file, text),
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
});
