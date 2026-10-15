#!/usr/bin/env node
/**
 * #1147 — sync the METIS roadmap board with the issues. The rules and their reasoning live in
 * `lib/sync-roadmap-core.mjs`; `docs/ops/roadmap-board.md` is the reader's version.
 *
 *   GH_TOKEN=... node scripts/sync-roadmap.mjs --org openzigs --project 2 [--dry-run]
 *
 * The token comes from GH_TOKEN or GITHUB_TOKEN and is never printed. Exits 2 on bad arguments
 * or a missing token; 1 on a failed read, or when any write failed (the run carries on past a
 * failed write and reports it at the end); 0 otherwise.
 */

import { main } from "./lib/sync-roadmap-core.mjs";

process.exitCode = await main({ argv: process.argv.slice(2), env: process.env });
