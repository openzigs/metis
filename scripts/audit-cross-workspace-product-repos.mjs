#!/usr/bin/env node
/**
 * `pnpm audit:product-repos` — list product repo attachments whose repo
 * connection's project is in a different workspace from the rest of the
 * product (#1258). READ-ONLY: the database is opened with SQLITE_OPEN_READONLY
 * and the query is a single SELECT. The rules and their reasoning live in
 * `lib/cross-workspace-product-repos-core.mjs`.
 *
 * Usage:
 *   node scripts/audit-cross-workspace-product-repos.mjs [--db <path>] [--json]
 *   node scripts/audit-cross-workspace-product-repos.mjs --sql   # print the SQL (e.g. for psql)
 *
 * `--db` defaults to `server/dev.db`. On Postgres, run the `--sql` output in a
 * read-only session: `psql "$DATABASE_URL" -c 'SET default_transaction_read_only = on' -f <file>`.
 *
 * Exit codes: 0 the audit ran (whatever it found), 1 bad arguments or an
 * unreadable database.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CROSS_WORKSPACE_PRODUCT_REPOS_SQL,
  formatReport,
  listCrossWorkspaceProductRepos,
  openReadOnly,
  parseArgs,
} from "./lib/cross-workspace-product-repos-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (args.help) {
  console.log(
    "Usage: node scripts/audit-cross-workspace-product-repos.mjs [--db <path>] [--json] [--sql]",
  );
  process.exit(0);
}

if (args.sql) {
  console.log(CROSS_WORKSPACE_PRODUCT_REPOS_SQL.trim());
  process.exit(0);
}

const dbPath = path.resolve(args.db ?? path.join(repoRoot, "server", "dev.db"));
let db;
try {
  db = openReadOnly(dbPath);
} catch (err) {
  console.error(`cannot open ${dbPath} read-only: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
try {
  const rows = listCrossWorkspaceProductRepos(db);
  console.log(args.json ? JSON.stringify(rows, null, 2) : formatReport(rows));
} finally {
  db.close();
}
