/**
 * Playwright configuration for the METIS full-flow + smoke suite (#144).
 *
 * - Boots the API server and the Next.js UI via `webServer` so a single
 *   `pnpm --filter @metis/e2e test` is enough on a fresh machine / CI runner.
 * - Records traces + video on first retry so failures are debuggable from CI
 *   artifacts without a re-run.
 * - Quarantines tests via `test.fixme()` or grep on the `@quarantine` tag.
 *   Quarantined cases are excluded from the default run; CI exposes them with
 *   `pnpm --filter @metis/e2e test --grep @quarantine`.
 * - `globalSetup` resets the dedicated SQLite test database + isolated data
 *   dirs before the webServers boot, so each run starts deterministic.
 *
 * Ports: 4101 (API) / 3101 (UI). These are intentionally NOT 4100/3100
 * (older smoke config) and NOT 4000/3000 (long-running dev stack from
 * `scripts/restart.sh --detached`) so the suite never collides with a
 * running dev session.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PORT_API = Number(process.env.E2E_API_PORT ?? 4101);
const PORT_UI = Number(process.env.E2E_UI_PORT ?? 3101);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT_UI}`;
const API_BASE = process.env.E2E_API_BASE ?? `http://127.0.0.1:${PORT_API}`;
const isCI = Boolean(process.env.CI);

// Deterministic, isolated data dirs. Mirrored in `global-setup.ts` so the
// migration step writes to the same SQLite file the server later reads.
const DATA_ROOT = process.env.E2E_DATA_DIR ?? path.join(__dirname, "test-results", "stack-data");
const DB_FILE = path.join(DATA_ROOT, "metis-e2e.db");
const UPLOAD_DIR = path.join(DATA_ROOT, "uploads");
const LANCEDB_PATH = path.join(DATA_ROOT, "lancedb");

// Epic #209 (#235) — committed record/replay LLM fixtures (#234). Setting
// `AI_REPLAY=1` + this dir makes the server install the deterministic
// ReplayProvider so the clarification→refinement→spec loop runs with NO live
// LLM credentials. Unrecorded requests fall back to the offline stub.
const LLM_FIXTURE_DIR = process.env.AI_FIXTURE_DIR ?? path.join(__dirname, "fixtures", "llm");

// Which AI provider the stack will run with. The deterministic default is the
// offline stub, whose replies are hash-derived PROSE: anything that needs the
// model to emit structured JSON (analysis agents, test-case suggestions) cannot
// work under it. Specs read `E2E_AI_OFFLINE` to skip — with a reason — rather
// than assert something the harness cannot produce. Point `AI_PROVIDER` at a
// real provider and those specs run.
const AI_PROVIDER = process.env.AI_PROVIDER ?? "offline-stub";
process.env.E2E_AI_OFFLINE = AI_PROVIDER === "offline-stub" ? "1" : "0";

// Expose the resolved DB path so test specs can reach into the SQLite file
// for fixtures that bypass the API surface (e.g. seeding requirements when
// the offline-stub AI provider can't produce structured output).
process.env.E2E_DB_FILE = DB_FILE;

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // Default run skips quarantined specs; surface them with `--grep @quarantine`.
  grepInvert: process.env.E2E_INCLUDE_QUARANTINE ? undefined : /@quarantine/,
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    extraHTTPHeaders: {
      // Surfaces this suite in server-side audit metadata.
      "x-metis-e2e": "full-flow",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : [
        {
          // No `start` script in server/package.json — invoke tsx directly so
          // we get one-shot execution (no `tsx watch`).
          command: `pnpm --filter @metis/server exec tsx src/index.ts`,
          url: `${API_BASE}/healthz`,
          timeout: 120_000,
          // Always boot fresh — `globalSetup` wipes the SQLite DB and a
          // reused server would still hold open file handles to the
          // deleted file, causing every auth call to 401.
          reuseExistingServer: false,
          cwd: REPO_ROOT,
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "development",
            PORT: String(PORT_API),
            METIS_NO_LISTEN: "0",
            DATABASE_URL: `file:${DB_FILE}`,
            DATABASE_PROVIDER: "sqlite",
            // `globalSetup` already runs `prisma migrate deploy`. Letting the
            // server's boot-time migration guard run a second `migrate deploy`
            // against the same SQLite file leaves the better-sqlite3 client
            // connection in a state where writes fail with "attempt to write a
            // readonly database". Skip the redundant boot migrate in e2e.
            METIS_SKIP_MIGRATE: "1",
            JWT_SECRET: process.env.JWT_SECRET ?? "e2e-jwt-secret-change-me-please-32bytes-long-ok",
            VAULT_MASTER_KEY:
              process.env.VAULT_MASTER_KEY ?? "ZTJlLXZhdWx0LWtleS1iYXNlNjQtMzItYnl0ZXMtcGxlYXNl",
            // Issue #144 AC: deterministic — no live AI provider, GitHub, or
            // external network. The offline-stub returns hash-derived
            // responses without I/O.
            AI_PROVIDER,
            AI_OFFLINE: AI_PROVIDER === "offline-stub" ? "1" : "0",
            // Epic #209 (#235) — replay recorded LLM fixtures (#234) for the
            // clarification → refinement → spec loop. Replay wins over the
            // offline stub; fixture misses still fall back to the stub, so the
            // rest of the deterministic suite is unaffected. No LLM keys needed.
            AI_REPLAY: process.env.AI_REPLAY ?? "1",
            AI_FIXTURE_DIR: LLM_FIXTURE_DIR,
            // Epic #129 (#148) — a script book makes the offline stub return
            // real native tool calls, selected by a marker in the message, so
            // `agents-skills.spec.ts` drives a whole tool loop. Unset (the
            // default) leaves the stub exactly as before. Needs AI_REPLAY=0.
            ...(process.env.AI_OFFLINE_SCRIPT_FILE
              ? {
                  AI_OFFLINE_SCRIPT_FILE: path.resolve(
                    REPO_ROOT,
                    process.env.AI_OFFLINE_SCRIPT_FILE,
                  ),
                }
              : {}),
            EMBED_BACKEND: "offline",
            VECTOR_STORE: "local",
            AUTH_MODE: "mock",
            CORS_ORIGIN: BASE_URL,
            UPLOAD_DIR,
            LANCEDB_PATH,
            // Disable the background ingest queue so uploads complete
            // synchronously and tests can assert immediately.
            INGEST_QUEUE: "off",
            // Epic #192 — closed-loop webhook secret for the e2e suite.
            GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? "e2e-closed-loop-secret",
            // Epic #739 — the drift reconciler's webhook receiver. Without a
            // secret it rejects every delivery with NO_SECRET_CONFIGURED, so
            // `issue-sync.spec.ts` could not drive a real drift (and the
            // badge's live-update path had no way to be exercised end to end).
            JIRA_WEBHOOK_SECRET: process.env.JIRA_WEBHOOK_SECRET ?? "e2e-jira-sync-secret",
            // The deterministic suite logs in many times per server lifetime
            // (each spec primes the admin via API + a UI login). The default
            // 20 req/15 min auth limiter throttles credential stuffing, not
            // e2e flows — raise it so a full-suite run never trips RATE_LIMITED.
            RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? "100000",
          },
        },
        {
          command: `pnpm --filter @metis/ui exec next dev -p ${PORT_UI}`,
          url: BASE_URL,
          timeout: 180_000,
          reuseExistingServer: false,
          cwd: REPO_ROOT,
          env: {
            NODE_ENV: "development",
            // The Next.js auth proxy (ui/src/lib/auth-proxy.ts) reads
            // METIS_API_URL — point it at the test API.
            METIS_API_URL: `${API_BASE}/api`,
            // The BROWSER socket connects straight to the API (it is not
            // proxied through Next). Without this it falls back to
            // `http://localhost:4000` — a developer's dev stack, or nothing at
            // all in CI — so every realtime assertion in the suite ran against
            // a socket that never connected ("Reconnecting…" forever).
            NEXT_PUBLIC_SOCKET_URL: API_BASE,
            NEXT_TELEMETRY_DISABLED: "1",
            // Opt-in isolated Next dev dir (read by ui/next.config.mjs). Only
            // forwarded when explicitly set, so CI keeps the default `.next`
            // (and never churns ui/next-env.d.ts). A developer whose own
            // `next dev` stack is already running can boot the e2e UI server
            // alongside it with `NEXT_DIST_DIR=.next-e2e pnpm --filter @metis/e2e test`.
            ...(process.env.NEXT_DIST_DIR ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR } : {}),
          },
        },
      ],
});
