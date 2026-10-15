#!/usr/bin/env node
/**
 * #1147 — sync the METIS roadmap board with the issues. The rules and their reasoning live in
 * `lib/sync-roadmap-core.mjs`; `docs/ops/roadmap-board.md` is the reader's version.
 *
 *   GH_TOKEN=... node scripts/sync-roadmap.mjs --org openzigs --project 2 [--dry-run]
 *
 * The token comes from GH_TOKEN or GITHUB_TOKEN and is never printed. Exits 2 on bad arguments
 * or a missing token, 1 on an API error, 0 otherwise.
 */

import { createClient, GraphQLError, parseArgs, sync } from "./lib/sync-roadmap-core.mjs";

/** @param {string} message */
function fail(message, code = 1) {
  console.error(`sync-roadmap: ${message}`);
  process.exitCode = code;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}

if (args) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    fail("set GH_TOKEN or GITHUB_TOKEN", 2);
  } else {
    try {
      const client = createClient({ token, dryRun: args.dryRun });
      await sync({ client, org: args.org, project: args.project, now: new Date() });
    } catch (error) {
      if (!(error instanceof GraphQLError)) throw error;
      fail(error.message);
    }
  }
}
