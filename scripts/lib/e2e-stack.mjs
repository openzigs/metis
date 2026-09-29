/**
 * The Playwright e2e stack's boot contract: where its data lives, how it is
 * prepared, and the commands that start its two web servers.
 *
 * #323 — Playwright starts every `webServer` entry BEFORE it runs
 * `globalSetup`. Resetting and migrating the test database in `globalSetup`
 * therefore happened after the API had already booted against a data
 * directory that did not exist yet (`prisma:error Cannot open database because
 * the directory does not exist`), so every boot-time read (runtime tunables,
 * vault secrets, the recovery sweeps) ran against no database. The reset and
 * migration now run inside the API web server's own command, chained with
 * `&&` ahead of the server, and leave a marker file that `globalSetup` checks:
 * if the preparation step is ever dropped from the command again, the run
 * fails in `globalSetup` instead of silently booting against nothing.
 *
 * #342 — the UI web server is pinned to webpack. Turbopack panicked mid-suite
 * ("an internal panic occurred outside the per-task panic boundary") and took
 * every later spec down with ERR_CONNECTION_REFUSED; the UI package's own
 * `dev` script already runs `next dev --webpack`.
 *
 * Imported by `e2e/playwright.config.ts`, `e2e/global-setup.ts` and the
 * runner `scripts/prepare-e2e-stack.mjs`; pure except for the file-system
 * calls in `prepareStack` / `assertStackPrepared`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** File written into the data root once the database is migrated. */
export const PREPARED_MARKER = ".stack-prepared";

/**
 * @typedef {object} StackPaths
 * @property {string} dataRoot  Absolute data root (wiped on every run).
 * @property {string} dbFile    SQLite database file.
 * @property {string} uploadsDir
 * @property {string} lanceDir
 * @property {string} marker    Marker written by `prepareStack`.
 * @property {string} databaseUrl `file:` URL for `dbFile`.
 */

/**
 * Resolve the stack's data paths. `E2E_DATA_DIR` wins; a relative value is
 * resolved against the current directory, so resolve once in the Playwright
 * process and hand the absolute root to child processes.
 *
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} env
 * @returns {StackPaths}
 */
export function resolveStackPaths(repoRoot, env) {
  const dataRoot = path.resolve(
    env.E2E_DATA_DIR || path.join(repoRoot, "e2e", "test-results", "stack-data"),
  );
  const dbFile = path.join(dataRoot, "metis-e2e.db");
  return {
    dataRoot,
    dbFile,
    uploadsDir: path.join(dataRoot, "uploads"),
    lanceDir: path.join(dataRoot, "lancedb"),
    marker: path.join(dataRoot, PREPARED_MARKER),
    databaseUrl: `file:${dbFile}`,
  };
}

/**
 * Wipe the data root, recreate its directories, migrate the database, and
 * write the marker. Must run before the API process opens the database.
 *
 * @param {StackPaths} paths
 * @param {{ migrate: (databaseUrl: string) => void, now?: () => Date }} deps
 */
export function prepareStack(paths, deps) {
  rmSync(paths.dataRoot, { recursive: true, force: true });
  mkdirSync(paths.uploadsDir, { recursive: true });
  mkdirSync(paths.lanceDir, { recursive: true });

  deps.migrate(paths.databaseUrl);

  if (!existsSync(paths.dbFile)) {
    throw new Error(`e2e stack: expected SQLite database at ${paths.dbFile} after migrate deploy`);
  }
  const preparedAt = (deps.now ?? (() => new Date()))().toISOString();
  writeFileSync(paths.marker, `${JSON.stringify({ preparedAt, dbFile: paths.dbFile })}\n`);
}

/**
 * Fail unless `prepareStack` ran for this data root. Called from
 * `globalSetup`, which Playwright runs only after the web servers are up — so
 * a missing marker means the API booted without a prepared database.
 *
 * @param {StackPaths} paths
 */
export function assertStackPrepared(paths) {
  if (!existsSync(paths.marker)) {
    throw new Error(
      `e2e stack: ${paths.marker} is missing — the test database was not prepared before ` +
        "the API web server booted. The API webServer command must run " +
        "`node scripts/prepare-e2e-stack.mjs &&` ahead of the server (#323).",
    );
  }
}

/** Command for the API web server: prepare the data root, then boot. */
export function apiServerCommand() {
  // No `start` script in server/package.json — invoke tsx directly so the
  // server runs one-shot (no `tsx watch`).
  return "node scripts/prepare-e2e-stack.mjs && pnpm --filter @metis/server exec tsx src/index.ts";
}

/**
 * Command for the UI web server, pinned to webpack (#342).
 *
 * @param {number} port
 */
export function uiServerCommand(port) {
  return `pnpm --filter @metis/ui exec next dev --webpack -p ${port}`;
}
