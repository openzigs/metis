/**
 * Playwright global setup for the full-flow suite.
 *
 * Playwright runs this AFTER the `webServer` entries are up, not before
 * (#323). Resetting and migrating the test database therefore cannot happen
 * here: the API web server's command does it (`scripts/prepare-e2e-stack.mjs`)
 * before the server process starts. Responsibilities here:
 *   1. Check that preparation step ran for this data root, so a config change
 *      that drops it fails the run instead of booting the API against a
 *      database that does not exist yet.
 *   2. Export the resolved data paths for specs that reach into the SQLite
 *      file or the data dirs.
 *   3. (Re)generate the record/replay LLM fixtures.
 *
 * With `E2E_SKIP_WEBSERVER` set the stack is someone else's: nothing here
 * resets it, and the check is skipped.
 *
 * We deliberately do NOT seed the admin user here. The mock auth provider
 * (server/src/lib/auth/mock-provider.ts) accepts `admin / password` and the
 * real `POST /api/auth/login` endpoint upserts the matching User row on
 * first hit (server/src/routes/auth.ts:`ensureUserRow`). The test fixture
 * `e2e/fixtures/seed-user.ts` documents the credential contract and primes
 * the row before the test body runs.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStackPrepared, resolveStackPaths } from "../scripts/lib/e2e-stack.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

export default async function globalSetup(): Promise<void> {
  const stack = resolveStackPaths(REPO_ROOT, process.env);
  if (!process.env.E2E_SKIP_WEBSERVER) assertStackPrepared(stack);

  // Export the resolved paths so test code can rely on the same canonical
  // values the API web server was started with.
  process.env.E2E_DATABASE_URL = stack.databaseUrl;
  process.env.E2E_UPLOAD_DIR = stack.uploadsDir;
  process.env.E2E_LANCEDB_PATH = stack.lanceDir;

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
