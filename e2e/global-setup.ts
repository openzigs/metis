/**
 * Playwright global setup for the full-flow suite.
 *
 * Runs once before any test process. Responsibilities:
 *   1. Resolve test data dirs (DB file, uploads dir, vector dir) so each
 *      `pnpm --filter @metis/e2e test` invocation starts from a clean,
 *      isolated state and never touches the dev stack on :4000/:3000.
 *   2. Drop any stale SQLite file left by a previous interrupted run.
 *   3. Apply Prisma migrations against the test SQLite database so the
 *      Express server can boot without manual setup.
 *
 * We deliberately do NOT seed the admin user here. The mock auth provider
 * (server/src/lib/auth/mock-provider.ts) accepts `admin / password` and the
 * real `POST /api/auth/login` endpoint upserts the matching User row on
 * first hit (server/src/routes/auth.ts:`ensureUserRow`). The test fixture
 * `e2e/fixtures/seed-user.ts` documents the credential contract and primes
 * the row before the test body runs.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function resolveDataRoot(): string {
  const dir = process.env.E2E_DATA_DIR ?? path.join(REPO_ROOT, "e2e", "test-results", "stack-data");
  return path.resolve(dir);
}

export default async function globalSetup(): Promise<void> {
  const dataRoot = resolveDataRoot();
  const dbFile = path.join(dataRoot, "metis-e2e.db");
  const uploadsDir = path.join(dataRoot, "uploads");
  const lanceDir = path.join(dataRoot, "lancedb");

  // Reset any state left over from a previous run.
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(lanceDir, { recursive: true });

  // Export the resolved paths so the webServer block in playwright.config.ts
  // and any test code can rely on the same canonical values.
  const databaseUrl = `file:${dbFile}`;
  process.env.E2E_DATABASE_URL = databaseUrl;
  process.env.E2E_UPLOAD_DIR = uploadsDir;
  process.env.E2E_LANCEDB_PATH = lanceDir;

  // Apply Prisma migrations to the fresh SQLite file. We run from the server
  // package so the prisma binary, schema, and migrations directory all
  // resolve correctly. `migrate deploy` is non-interactive and idempotent.
  execSync("pnpm --filter @metis/server exec prisma migrate deploy", {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: "sqlite" },
    stdio: "inherit",
  });

  if (!existsSync(dbFile)) {
    throw new Error(`globalSetup: expected SQLite database at ${dbFile} after migrate deploy`);
  }

  // Epic #209 (#235) — (re)generate the committed record/replay LLM fixtures
  // for the clarification → refinement → spec loop. The builder is deterministic
  // and needs NO live LLM credentials: it hand-authors the responses and only
  // computes each fixture's `fixtureKey()` from the live prompt builders, so the
  // committed fixtures stay in lock-step with the server's prompts. Idempotent —
  // re-running overwrites the same three `<key>.json` files.
  const fixtureDir = process.env.AI_FIXTURE_DIR ?? path.join(REPO_ROOT, "e2e", "fixtures", "llm");
  mkdirSync(fixtureDir, { recursive: true });
  execSync("pnpm --filter @metis/server exec tsx scripts/e2e-build-clarify-fixtures.ts", {
    cwd: REPO_ROOT,
    env: { ...process.env, AI_FIXTURE_DIR: fixtureDir },
    stdio: "inherit",
  });
}
