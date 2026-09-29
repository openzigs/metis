# METIS — Development Guide

> Onboarding handbook for contributors. Covers local setup, the daily inner loop, common tasks, and the project's coding conventions. Pair with [`ARCHITECTURE.md`](./ARCHITECTURE.md) for system context and [`OPERATIONS.md`](./OPERATIONS.md) for production deployment.

---

## 1. Local Setup

### 1.1 Prerequisites
- Node.js 20 or 22 (see `.nvmrc`)
- pnpm 10.33+ (`corepack enable && corepack prepare pnpm@10.33.0 --activate`)
- (Optional) Docker for the Postgres + UI compose stack
- (Optional) `sqlite3` CLI for local DB inspection

### 1.2 First-time bootstrap

> **Quick path (Epic #359):** `pnpm bootstrap` does the four manual steps below — copies `.env`, generates the four required secrets via `openssl rand -hex 32`, ensures the `metis-mcp` Docker network exists, and pulls the wrapper images. Add `--up` (or run `pnpm bootstrap:up`) to also `docker compose up -d` and tail the server until `/readyz` is green. The full step-by-step is in [`docs/LOCAL_QUICKSTART.md`](./LOCAL_QUICKSTART.md).

```bash
git clone <repo> && cd metis
pnpm install                           # installs all workspaces
pnpm bootstrap                         # cross-platform: creates .env + secrets, network, wrappers
pnpm db:generate                       # generate Prisma client
pnpm db:migrate                        # apply migrations to local SQLite
pnpm db:seed                           # seed dev users + sample project
pnpm dev                               # boots server (4000) + ui (3000) in parallel
```

> `pnpm bootstrap` (Epic #183 / #188) replaces the old `cp .env.example .env` +
> manual secret steps (Node-based, no `bash`/`openssl` required). If you prefer
> to copy the env file manually, `cp .env.example .env` and generate the secrets
> yourself. On Windows, work inside WSL2 (§7.6).

Open http://localhost:3000 and log in with the seeded admin (`admin@metis.local` / `admin`).

---

## 2. Repository Layout

```
metis/
  server/              Express + Socket.IO API (Vitest)
  ui/                  Next.js 16 / React 19 (Vitest + RTL)
  packages/shared/     Zod schemas, types, RBAC permissions shared by server & UI
  packages/ui-kit/     Reusable React primitives (shadcn-derived)
  e2e/                 Playwright end-to-end smoke suite
  scripts/             Operational scripts (backup.sh, restore.sh, …)
  docs/                User, architecture, ops, security, dev guides
  .github/workflows/   CI — lint, typecheck, test, coverage, security, e2e
```

### 2.1 Architectural rules
- **Shared types live in `packages/shared`.** Server and UI both depend on it; UI never imports from `server/src`.
- **Routes are thin.** Business logic lives in `server/src/lib/<domain>/<service>.ts`; route handlers translate HTTP to/from service calls.
- **Every persisted secret goes through the vault.** Never `prisma.<table>.create({ data: { token } })` with a plaintext value.
- **Every outbound HTTP** with a user-influenced URL goes through `assertConnectorHostAllowed` + DNS-pin lookup.

---

## 3. Inner Loop

### 3.1 Daily commands

```bash
pnpm dev                   # parallel server + ui watch
pnpm test                  # vitest run across all workspaces
pnpm test:coverage         # also writes coverage/ artifact
pnpm lint                  # NUL-byte + private-vocabulary gates, then ESLint, max 0 warnings
pnpm typecheck             # tsc --noEmit
pnpm format                # prettier write
pnpm format:check          # prettier check (used by CI)
```

**Integration tests (#323).**
Server-side `*.integration.test.ts` files (currently the real-repo Code
Discovery suite at `server/tests/integration/code-graph-real-repo.integration.test.ts`)
are excluded from the default `pnpm test` so the inner-loop run stays fast.
They have their own vitest config (`server/vitest.integration.config.ts`,
`testTimeout: 120000`, gated by `RUN_INTEGRATION_TESTS=1`):

```bash
pnpm --filter @metis/server test:integration
```

The CI quality gate batches the full set:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

**`pnpm test` verifies the eval doc corpus first (#1382).**
`eval-data/corpus/*/docs/` is a second copy of this repository's own `docs/*.md` frozen
at each corpus's `snapshotCommit`, and 34 doc-retrieval tests read it. The files are
committed (force-added past an ignore rule that keeps new files out), so the root `test`
script's `pnpm eval:restore-corpus` step is normally a no-op that checks each file
against the sha256 in `snapshot-manifest.json`. This repository's history starts after
`snapshotCommit`, so a missing snapshot cannot be rebuilt from `git show` here — restore
it with `git checkout -- eval-data/corpus`.

**Private-vocabulary gate.** `pnpm lint` runs
`scripts/verify-no-company-identifiers.mjs` before ESLint (also `pnpm identifiers:verify`).
METIS was developed privately before it was published, and some names may not re-enter
the tree. **The list of those names is not in this repository** — a published list of
banned words would be the disclosure it exists to prevent. Maintainers hold it; CI
receives it as the `METIS_PRIVATE_TERMS` secret. Without it the gate prints `SKIPPED —
nothing was checked` and passes, which is the expected result for an outside
contributor or a fork pull request; the maintainers' CI runs the real check on push.
Matching is case- and separator-insensitive (`Foo_Bar`, `fooBar` and `foo-bar` are one
name), tracked PATHS are scanned as well as contents, a file that cannot be read fails
the gate (unknown is not clean, #1215), and a hit is reported as `file:line  term #N` —
never the matched text, because this repository's CI logs are public.

There is **no path exclusion list**, since #1382. The gate carried one while #1308's
"`eval-data/` and `eval-results/` do not ship" decision was unimplemented; implementing
it untracked `eval-results/` and the corpus doc snapshots and left the other 139
`eval-data/` files tracked, at which point the exclusion was excusing files that now
ship. Two of them carried the identifier. The scan is 100% of tracked text files.

### 3.2 Workspace-scoped variants

```bash
pnpm --filter @metis/server test
pnpm --filter @metis/ui   test
pnpm --filter @metis/server vitest run tests/path/to.test.ts
pnpm --filter @metis/server prisma studio
```

### 3.3 Pre-commit hooks
Husky + lint-staged run `eslint --fix` + `prettier --write` on staged TS files. To skip in an emergency: `git commit --no-verify` (PR review will catch what the hook would have).

---

## 4. Adding a New Feature

The team's conventional flow for a new sub-issue (assumes you have a GitHub issue number `N`):

### 4.1 Branch + plan
```bash
git checkout main && git pull --rebase
git checkout -b feature/issue-N-short-description
gh issue view N
```

### 4.2 Test-driven implementation
1. Write a failing test in `server/tests/<area>.test.ts` or `ui/src/**/__tests__/`.
2. Implement the smallest change that makes it pass.
3. Cover edge cases + error paths until the coverage gate (server 80% / UI 60%) holds.
4. Update [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) if you added a new module or contract.
5. Update [`docs/USER_GUIDE.md`](./USER_GUIDE.md) if you changed user-facing behaviour.

### 4.3 Schema changes
Prisma maintains **twin schemas** for SQLite (dev) and Postgres (prod). The
Postgres copy is autogenerated from the SQLite source so they cannot drift:
- `server/prisma/schema.prisma` — sqlite, default (canonical source)
- `server/prisma/postgres/schema.prisma` — postgres (autogenerated; do not hand-edit)

Workflow:

```bash
# 1. Edit schema.prisma (sqlite source of truth)
# 2. Generate sqlite migration:
pnpm --filter @metis/server db:migrate -- --name <change_description>
# 3. Regenerate the postgres twin:
pnpm --filter @metis/server db:gen-postgres
# 4. Generate the matching postgres migration:
pnpm --filter @metis/server db:migrate:postgres -- --name <change_description>
```

A CI parity guard ([`server/tests/schema-parity.test.ts`](../server/tests/schema-parity.test.ts))
fails the build if the two schemas diverge.

### 4.4 Commit + PR
```bash
git add <only-the-files-you-touched>   # NEVER `git add -A` in this repo
git commit -m "feat(area): short description (#N)"
git push -u origin feature/issue-N-short-description
gh pr create --fill --body "Closes #N"
```

Conventional Commits format is mandatory (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `ci:`). The PR body must contain `Closes #N` for every issue resolved.

---

## 5. Testing Conventions

### 5.1 Server (Vitest)
- Test files live next to the code they test (`*.test.ts` adjacent) or under `server/tests/` for cross-module integration.
- Use `supertest` for HTTP-level assertions on the Express app.
- Reset module-level singletons between tests (`__resetSchedulerBootstrap()`, `resetMetricsForTests()`, etc.).
- Fixtures live in `server/tests/fixtures/`. Don't hit the network — every external call should be mocked.

#### The unit suite needs no database, on either provider (issue #876)

`pnpm test` stubs Prisma per-suite (`vi.mock("../src/lib/prisma.js", …)`) and executes **no
SQL at all** — a full run on a clean checkout leaves `server/dev.db` at 0 bytes. So it needs
neither Postgres nor Docker, and `git clone && pnpm install && pnpm test` works offline.

What it *does* need is a driver adapter compatible with the generated Prisma client, whose
provider is baked in at `prisma generate` time. `server/tests/setup-datasource.ts` handles
that: it reads the provider off the `schema.prisma` Prisma emits beside the generated client
and points `DATABASE_URL` at a matching (never-connected) datasource, but only when the two
disagree. Consequences worth knowing:

- **`scripts/dev-db.sh postgres` no longer blocks testing.** Dev on Postgres and `pnpm test`
  coexist in one working tree; the `prisma generate` toggle is gone.
- **Two things read `DATABASE_URL` for different reasons.** The adapter reads it once at
  import; provider-conditional application code (`resolveReindexLeaseBackend()`,
  `detectLineageSqlEngine()`, `resolveDatabaseProvider()`) reads it lazily, per call. A unit
  test that reaches such code must **pin the datasource itself** — `delete
  process.env.DATABASE_URL` in `beforeEach` (plus `__resetReindexLeaseBackend()` where a
  lease is involved) — rather than inherit whatever your shell holds. Skipping this is how a
  test passes on SQLite and fails on Postgres wired to a `vi.fn()` mock.
- **One suite is genuinely SQLite-only.** `src/lib/portability/logical-roundtrip.test.ts`
  builds real SQLite files and skips on a Postgres-generated client. CI's `api` job builds
  the SQLite client, so it still runs on every PR.
- **Real-Postgres parity stays in `pnpm test:integration`** and the `postgres-adapter` CI
  job, which also runs the full unit suite against the Postgres client as the regression
  gate for all of the above.

### 5.2 UI (Vitest + React Testing Library)
- Prefer behavioural assertions (`getByRole`, `getByLabelText`) over snapshot tests.
- Mock TanStack Query via the shared helper in `ui/tests/setup.ts`.
- Keep tests focused on one component contract — for full-page flows, write a Playwright e2e instead.

### 5.3 Playwright e2e
- Live in `e2e/tests/*.spec.ts`. The default run boots the API + UI via Playwright's `webServer` config — no manual start required.
- Tag flaky tests with `@quarantine` to exclude them from the default run; they still execute via `--grep @quarantine` in a dedicated CI lane.
- Failures upload `e2e/playwright-report/` and `e2e/test-results/` as CI artifacts (traces + video on first retry).

#### Running the gated sandbox e2e locally (Epic #395 #420)

`e2e/tests/sandbox-ba-loop.spec.ts` exercises the BA-loop "fail then
fix" round-trip against the **real configured sandbox provider** (E2B
in CI, optionally Daytona/local-dev locally). Because it spins up
billable vendor sandboxes it is **gated on `E2B_API_KEY`** and is a
no-op in the standard CI lane — the dedicated `e2e-sandbox-e2b`
workflow runs it on `push: main` and `workflow_dispatch` only.

To run it on your laptop against E2B:

```bash
export E2B_API_KEY=e2b_xxx          # required — test self-skips otherwise
export SANDBOX_PROVIDER=e2b         # default in the gated workflow
pnpm --filter @metis/e2e e2e -- e2e/tests/sandbox-ba-loop.spec.ts
```

Expected duration: ~30–60 s end-to-end (60 s sandbox lifetime cap +
90 s test timeout). The test creates a fresh project, posts two
`POST /api/sandbox/run-once` requests (one with `sys.exit(2)`, one
with `print("ok")`) and asserts the second session's exit code is 0
and the two sessions have distinct ids.

To run it offline against the `local_dev` adapter (no E2B billing,
macOS/Linux only — see `LocalDevSandboxProvider`):

```bash
export E2B_API_KEY=offline-stub     # value ignored, just satisfies the gate
export SANDBOX_PROVIDER=local_dev
pnpm --filter @metis/e2e e2e -- e2e/tests/sandbox-ba-loop.spec.ts
```

### 5.4 Coverage gates
| Workspace | Thresholds |
|---|---|
| `@metis/server` | statements/branches/functions/lines ≥ 80% |
| `@metis/ui` | statements/branches/functions/lines ≥ 60% |

Coverage runs as a dedicated CI job and uploads artifacts. To inspect locally:

```bash
pnpm --filter @metis/server test:coverage
open server/coverage/index.html
```

---

## 6. Common Tasks Cheat Sheet

| Task | Command |
|---|---|
| Reset the local SQLite DB | `pnpm db:reset` |
| Inspect the DB visually | `pnpm db:studio` |
| Run only one test file | `pnpm --filter @metis/server vitest run tests/foo.test.ts` |
| Generate a Prisma migration | `pnpm db:migrate -- --name describe_change` |
| Test the MCP CLI | `pnpm mcp:test` |
| Smoke-test backup/restore | `BACKUP_DIR=/tmp/m bash scripts/backup.sh && bash scripts/restore.sh /tmp/m/metis-backup-*.tar.gz` |
| Run e2e once | `pnpm --filter @metis/e2e e2e` |
| Open Playwright UI mode | `pnpm --filter @metis/e2e e2e:ui` |
| Show coverage in browser | `pnpm --filter @metis/server test:coverage && open server/coverage/index.html` |
| Lint just one workspace | `pnpm --filter @metis/server lint` |

---

## 6.1 Troubleshooting

### Native Module Compilation (Prisma 7+)

The Prisma 7 upgrade uses `@prisma/adapter-better-sqlite3` which depends on `better-sqlite3`, a native C++ addon compiled via `node-gyp`. If you see errors like:

```
Could not locate the bindings file. Tried:
  → .../better-sqlite3/build/better_sqlite3.node
  → .../better-sqlite3/build/Release/better_sqlite3.node
```

Run:

```bash
pnpm rebuild better-sqlite3
```

This recompiles the native SQLite3 bindings for your current Node.js version. This typically happens when switching Node.js versions (via `nvm use`) after a previous install.

---

## 7. Coding Conventions

### 7.1 TypeScript
- Strict mode is on. No `any` (use `unknown` + type narrowing).
- Prefer named exports; reserve default exports for Next.js page components.
- Import from `@metis/shared` for any type used by both server and UI.
- Module-level singletons get a `reset…ForTests()` companion.

### 7.2 Express
- One router per route file, returned from a `<area>Router()` factory.
- Service errors are `AppError` subclasses; the global error handler maps them to JSON.
- Validate request bodies with the zod schema from `packages/shared`.

### 7.3 React / Next.js
- Functional components only; hooks for state.
- Tailwind + shadcn primitives (`packages/ui-kit`); avoid raw CSS modules.
- Colour through the theme tokens in `ui/src/app/globals.css`, not the raw palette: status is
  `success` / `warning` / `info` / `destructive` (`text-warning`, `bg-warning-muted`, or the
  `Badge` / `Alert` variants of the same names), chart series and categorical colours are
  `--chart-1..7` (`bg-chart-3`, `hsl(var(--chart-3))`). Every token pair is contrast-tested in
  both themes (`ui/tests/contrast-tokens.test.ts`), and `ui/tests/a11y/semantic-token-migration.test.ts`
  fails on any raw palette class (`text-amber-700`, `bg-white`) in `ui/src` or `packages/ui-kit/src`.
- Every page opens with the ui-kit `PageHeader` (title, description, actions — the one `<h1>`
  style); empty lists use `EmptyState`, route `loading.tsx` uses `PageHeaderSkeleton`
  (`ui/tests/page-shell-conventions.test.ts`).
- Heavy viewers load on demand: `loadMermaid()` (`ui/src/lib/mermaid.ts`), `useKatexCss()`,
  and `next/dynamic` for the schema graph and diff viewer. A static value import of `mermaid`,
  `@xyflow/react` or `react-diff-viewer-continued` fails `ui/tests/lazy-heavy-viewers.test.ts`.
- Tabs, modals and confirmations use the ui-kit `Tabs`, `Dialog` and `AlertDialog` /
  `ConfirmDialog` — never a hand-rolled `role="tablist"`, a `fixed inset-0` backdrop or
  `window.confirm`. Icon-only buttons need an `aria-label`. `ui/tests/a11y/` enforces all four.
- Server-rendered routes (`app/`) are thin — fetch via TanStack Query in client components.

### 7.4 Logging
- Use `createChildLogger("module-name")` rather than `console.log`.
- Pass structured meta as the second arg: `log.info("ai.session.started", { sessionId })`.
- Never log raw secrets or full request bodies. The redaction format catches common keys but the safest pattern is "log the shape, not the data".

### 7.5 Local sandbox provider (Epic #395 #417)

The `local_dev` sandbox provider gives you a process-isolated fallback when you don't want to spend on E2B/Daytona. It is **never** enabled in production (the provider WARN-logs and refuses to start outside `NODE_ENV=development` once you've activated it) and requires a host-side tool:

- **Linux:** `apt-get install -y bubblewrap` (Debian/Ubuntu) or `dnf install -y bubblewrap` (Fedora/RHEL).
- **macOS:** `sandbox-exec` ships with the OS; nothing to install.
- **Windows / unsupported:** the provider throws `LocalDevSandboxUnavailableError` at construction time with install guidance — use `SANDBOX_PROVIDER=noop` or wire up E2B/Daytona instead.

Activate with `SANDBOX_PROVIDER=local_dev` in `.env`. Sessions still flow through `clampSandboxOptions` (vCPU/mem/egress allowlist) and the `SandboxAuditEmitter`, but cost is always recorded as `0` because there is no per-session billing.

---

## 7.6 Developing on Windows: use WSL2 (#354)

Native Windows development is **not supported**. On a Windows machine, develop
inside **WSL2** (Ubuntu or any current distribution) and follow the Linux
instructions in this guide unchanged. CI runs on Linux only; there is no
`windows-latest` job (it was removed in #354).

- Clone the repository **inside the WSL2 filesystem** (for example
  `~/src/metis`), not under `/mnt/c/...`. Files on the Windows drive are slow
  to watch and install into, and they pick up CRLF line endings.
- Install Node.js 22 and pnpm (`corepack enable`) inside WSL2, not on Windows.
- Docker Desktop with the WSL2 backend, or Docker Engine installed in the
  distribution, both work for the compose stack.
- The `local_dev` sandbox provider works under WSL2 once `bubblewrap` is
  installed (`sudo apt install bubblewrap`); see §7.5.

Some tooling (`pnpm bootstrap`, `pnpm clean`, the embeddings path) still
happens to run on native Windows because it is plain Node, but nothing
exercises that in CI and defects there are not treated as bugs.

### 7.6.1 Local Gemma inference on a Windows GPU box
Running the **model server** (Ollama) on a Windows machine with an NVIDIA GPU
is still fine: METIS only talks to it over HTTP. See [§4 of the User Guide →
"Run Gemma locally on a Windows GPU box"](./USER_GUIDE.md#run-gemma-locally-on-a-windows-gpu-box),
and point `LOCAL_GEMMA_BASE_URL` at it (an IP literal, ending in `/v1`) from the METIS stack running in WSL2.

---

## 8. References
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`docs/OPERATIONS.md`](./OPERATIONS.md) — production operations
- [`docs/SECURITY.md`](./SECURITY.md) — threat model + secret handling
- [`docs/USER_GUIDE.md`](./USER_GUIDE.md) — end-user documentation
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — CI pipeline
