#!/usr/bin/env node
/**
 * Reset and migrate the Playwright e2e stack's data root (#323).
 *
 * Runs as the first half of the API web server's command in
 * `e2e/playwright.config.ts`, so the database exists and is migrated before
 * the API process opens it. The logic lives in `scripts/lib/e2e-stack.mjs`;
 * this file only does I/O.
 *
 * Usage (normally invoked by Playwright, from the repo root):
 *   E2E_DATA_DIR=/abs/path node scripts/prepare-e2e-stack.mjs
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareStack, resolveStackPaths } from "./lib/e2e-stack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveStackPaths(repoRoot, process.env);

prepareStack(paths, {
  migrate: (databaseUrl) => {
    // `migrate deploy` is non-interactive; run from the server package so the
    // prisma binary, schema and migrations directory all resolve.
    execSync("pnpm --filter @metis/server exec prisma migrate deploy", {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: "sqlite" },
      stdio: "inherit",
    });
  },
});

console.log(`e2e stack prepared: ${paths.dbFile}`);
