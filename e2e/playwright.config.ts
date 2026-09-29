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
 * - Playwright starts the `webServer` entries BEFORE it runs `globalSetup`
 *   (#323). So the API web server's own command resets the dedicated SQLite
 *   test database + isolated data dirs and migrates the database
 *   (`scripts/prepare-e2e-stack.mjs`) before the server process starts, and
 *   `globalSetup` — which runs once both servers answer — only checks that this
 *   happened. Each run starts deterministic, and every boot-time read in the
 *   API finds a migrated database.
 *
 * Ports: 4101 (API) / 3101 (UI). These are intentionally NOT 4100/3100
 * (older smoke config) and NOT 4000/3000 (long-running dev stack from
 * `scripts/restart.sh --detached`) so the suite never collides with a
 * running dev session.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { apiServerCommand, resolveStackPaths, uiServerCommand } from "../scripts/lib/e2e-stack.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PORT_API = Number(process.env.E2E_API_PORT ?? 4101);
const PORT_UI = Number(process.env.E2E_UI_PORT ?? 3101);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT_UI}`;
const API_BASE = process.env.E2E_API_BASE ?? `http://127.0.0.1:${PORT_API}`;
const isCI = Boolean(process.env.CI);

// Deterministic, isolated data dirs, resolved once here (absolute) and handed
// to the API web server as E2E_DATA_DIR, so the preparation step migrates the
// same SQLite file the server then reads and `global-setup.ts` checks.
const STACK = resolveStackPaths(REPO_ROOT, process.env);
const DATA_ROOT = STACK.dataRoot;
const DB_FILE = STACK.dbFile;
const UPLOAD_DIR = STACK.uploadsDir;
const LANCEDB_PATH = STACK.lanceDir;

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
          // #323 — reset + migrate the data root, THEN boot the server (one-shot
          // tsx, no `tsx watch`). See scripts/lib/e2e-stack.mjs.
          command: apiServerCommand(),
          url: `${API_BASE}/healthz`,
          timeout: 120_000,
          // Always boot fresh — the preparation step wipes the SQLite DB and a
          // reused server would still hold open file handles to the
          // deleted file, causing every auth call to 401.
          reuseExistingServer: false,
          cwd: REPO_ROOT,
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "development",
            // Read by scripts/prepare-e2e-stack.mjs; absolute, so the child's
            // cwd cannot move the data root.
            E2E_DATA_DIR: DATA_ROOT,
            PORT: String(PORT_API),
            METIS_NO_LISTEN: "0",
            DATABASE_URL: `file:${DB_FILE}`,
            DATABASE_PROVIDER: "sqlite",
            // The preparation step in `command` already ran `prisma migrate
            // deploy` against this file, so the server's boot-time migration
            // guard would only repeat it. Skip the redundant boot migrate.
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
            // Ingest is QUEUED in this stack, as in production (#322, #332):
            // `documentsRouter` queues whenever NODE_ENV is not "test", so an
            // upload answers 202 with its document `pending`, and it turns
            // `ready` moments later. Assert on the rendered ready state, never
            // on a synchronous ingest; there is no switch that makes it so.
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
            // Same reasoning for the per-user `/api/admin` and `/api/mcp`
            // limiters (60 req / 15 min, server/src/middleware/mcp-admin-rate-limit.ts):
            // every spec is the one admin user. The production-build UI (#342)
            // runs the suite fast enough to put >60 admin calls in one window,
            // which failed token-usage.spec.ts with 429s.
            ADMIN_RATE_LIMIT_MAX: process.env.ADMIN_RATE_LIMIT_MAX ?? "100000",
            MCP_RATE_LIMIT_MAX: process.env.MCP_RATE_LIMIT_MAX ?? "100000",
            // #221 — never close an idle keep-alive socket from the server side.
            // Each APIRequestContext pools its sockets in a keep-alive
            // http.Agent (one per context since playwright-core 1.63; one shared
            // by every context before). That agent has no `timeout`, so Node
            // never applies the server's `Keep-Alive: timeout=5` hint to it: a
            // pooled socket stays "free" until the pool sees the server close
            // it. Node's default closes an idle socket at ~6 s; a request that
            // reuses the socket as that happens — a window as wide as any
            // event-loop lag on a loaded runner — dies with `socket hang up` /
            // `ECONNRESET`. Long-lived contexts (a spec's `adminApi`, a
            // `beforeEach` `api`) are exposed. Nothing waits longer because of
            // this: it removes the one close the client cannot see, and sockets
            // close when their context is disposed. Production keeps Node's
            // default unless an operator sets it.
            HTTP_KEEP_ALIVE_TIMEOUT_MS: process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? "0",
          },
        },
        {
          // #342 — a webpack production build, then `next start`: no dev
          // compiler runs during the suite. A Turbopack dev panic killed this
          // server mid-suite (every later spec: ERR_CONNECTION_REFUSED), and
          // webpack dev doubled the suite's run time. See scripts/lib/e2e-stack.mjs.
          command: uiServerCommand(PORT_UI),
          url: BASE_URL,
          // Covers the build as well as the boot.
          timeout: 420_000,
          reuseExistingServer: false,
          cwd: REPO_ROOT,
          env: {
            // `next build` / `next start` expect production; NEXT_PUBLIC_* below
            // are inlined by the build, which runs inside this same command.
            NODE_ENV: "production",
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
