# METIS — Claude Code Project Instructions

Multi-package TypeScript monorepo: `server/` (Express + Prisma + LanceDB RAG), `ui/`
(Next.js 14 + Tailwind + shadcn), `packages/` (shared types + ui-kit), `e2e/` (Playwright).
Structural detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**This file is reloaded into every non-Explore subagent, so each line is paid per
delegation.** It holds only what is true in *every* session; conditional detail belongs in
a skill, which loads on match (#1144).

**Metis uses the GitHub Copilot SDK** (`@github/copilot-sdk` in `server/`,
`@github/copilot` at the root) — **not** the Vercel AI SDK. Verify every SDK, framework or
dependency claim against `package.json`, lockfiles and imports, citing the path, before
writing it into an issue, epic or doc; confirm the target repo (`owner/name`) before
creating anything on GitHub. A wrong claim propagated into an epic costs a correction sweep
across every sub-issue.

## Navigating the codebase

Search with **`grep`/`find` in `Bash`**, scoped to `server/src`, `ui`, `packages` rather
than the repo root; dispatch **Explore** for a wide sweep (Explore and Plan are the only
subagents that skip loading this file). **`Grep` and `Glob` are not available in this build** —
all seven agents declared them and none could call them, so `agents:verify` now rejects the
declaration (#1168, measured).

**Do not route navigation through graphify** — on 10 measured structural questions it
scored 2/10 at 4× the tokens of `Grep`/`Glob` (the then-available search route), losing
every question on both axes, and
`graphify path` walks the import graph **undirected**, printing routes that do not exist
(docs/decisions/0004-graphify-agent-navigation.md). `graphify-out/` is untracked and
gitignored, with no CI refresh, so nothing to commit and no #916 treadmill (#1152).

## Build, test, gate

```bash
pnpm install --frozen-lockfile --prod=false
pnpm lint && pnpm typecheck && pnpm test    # gate before every push
```

`pnpm test` fans out to each package's `vitest run`, which exits cleanly. **Never use watch
mode; never background a process** (`&`, `nohup`). Batch shell commands with `&&`; wrap slow
scans in `timeout 30 <cmd> || echo ...`.

**If `typecheck` reports a missing export from `@metis/shared`, the shared build is stale —
run `pnpm --filter @metis/shared build`.** The export is almost never actually missing;
this red herring produced five false diagnoses in one session.

Every change: **80% unit-test coverage**; an **OWASP Top 10** pass on new code (no SQL
injection, no raw user input in shell commands, no secrets in code); for user-facing work,
one `.changes/unreleased/<issue>-<slug>.md` fragment, never `CHANGELOG.md` (#1191).
**Never bump a version in a PR** — versions move only when cutting a tagged release
(SemVer, `0.x.y` = pre-stable). Per-language conventions:
`.github/instructions/*.instructions.md`.

## CI and merging — three ways the signal lies

`main` has **no required status checks**, so `gh pr merge --auto` does not wait for CI: it
merges the moment it is armed. **Never use `--auto`.**

```bash
gh pr checks <pr> --watch                   # blocks — but exits 0 too early
gh pr checks <pr>                           # RE-READ: full set present, zero pending
gh pr merge <pr> --squash --delete-branch   # only after a clean re-read
```

1. **`api` = `fail` usually means *cancelled*.** `api` queues on the ref-independent
   `api-docker-build` group (deliberate — one Docker daemon), so a third run cancels an
   already-pending job and the superseded `api` reads red having built nothing. Read the
   **`api-outcome`** check: it passes on a supersede, and fails only on a genuine `api`
   failure. Confirm with `gh run view <id> --json jobs`, then **re-run the job — do not
   "fix" anything** (#1067).
2. **`postgres-adapter` can exit 1 with every test passing** — a vitest
   `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` from
   `server/tests/lib/testcoverage/cost-tracker.test.ts`. **Discriminate on the `Test Files`
   line, never on the `Errors` block** — that teardown error is present either way.
   `Test Files … 0 failed` ⇒ teardown alone: re-run. **`Test Files 1 failed` naming a file
   is a REAL suite-level failure — never re-run it away**: a failed `beforeAll` *skips* its
   tests, so the *test* tally still reads zero failed and looks identical (#1288). That was
   measured on this teardown shape; one other reading is known and is still **not** a
   re-run. A file line whose duration ≈ the package's `testTimeout`
   (`(7 tests | 1 failed) 20076ms` vs `testTimeout: 20_000`) is a **timeout** — read the
   failure text before anything else. If that test does no real I/O of its own, the
   monorepo fan-out starved it, and the fix is to cut the test's tie to a contended
   machine resource, never a re-run or a bigger timeout (#1379).
3. **`--watch` lies twice** — it has exited 0 with jobs still pending (3× in one session),
   and between runs it can return a **transient empty check set** that reads as success.
   Require the full expected check set present with zero `pending` on a plain re-read.

Never merge a PR with genuinely failing or pending checks.

## Operational rules

- **The main session orchestrates; subagents are workers.** Sequence waves yourself and
  dispatch `code-issue` directly — **one implementer per issue**. There is deliberately no
  `orchestrator` subagent (#1145,
  docs/decisions/0003-retire-the-claude-code-orchestrator-subagent.md).
- **Parallel implementers must be worktree-isolated — always.** Two agents in one checkout
  clobber each other's branch and HEAD; ~13 isolated agents in one session hit that zero
  times (#1147). An agent in `.claude/worktrees/agent-*` runs `git worktree lock .`
  immediately and unlocks before finishing (#992). Two consequences bite every time: a fresh
  worktree's `@metis/shared` build is stale (see the gate above), and
  **`gh pr merge --delete-branch` deletes NEITHER branch when a worktree holds it** — it
  aborts on the local delete, so the *remote* branch survives too. The merge itself landed;
  confirm with `gh pr view <pr> --json state,mergedAt` and do not "fix" the merge. But the
  stale remote is why `worktrees:prune` then reports `active` instead of `branch-gone` and
  the worktree never becomes prunable: 40 branches and 16 worktrees holding 8.1 GB had
  accumulated before anyone checked (2026-07-31; the earlier "only the local delete failed"
  claim from #1147 was wrong). After merging from a worktree, finish the job:

  ```bash
  gh pr list --state all --head <branch> --json state   # confirm MERGED first
  git push origin --delete <branch> && git fetch --prune
  pnpm worktrees:prune --yes                            # ~1 min per worktree; re-run, don't assume a timeout failed
  ```
- **A subagent's `Durable finding:` line is the dispatcher's to persist** — `code-review` and
  `ui-vision` have no store (#1163). Write it to `.claude/agent-memory/code-issue/`, in-tree:
  the main session's own memory is per-machine and uncommitted, so nothing else would see it.
- **Commit anything written under `.claude/agent-memory/`; never leave it in a worktree.**
  It is the cross-session diagnosis channel, and one uncommitted memory file survived only
  by being rescued by hand (#1147). `pnpm worktrees:prune` now refuses to delete a worktree
  holding uncommitted memory; that and the rest of the cleanup semantics live in the
  `worktree-hygiene` skill. A store's `MEMORY.md` is **budgeted at 17,500 bytes and each
  entry at 150** by `agents:verify`: past ~25,000 the index is silently not loaded at all,
  so retire superseded pointers to the store's `ARCHIVE.md`, which is never loaded and
  never deletes the file (#1206).

## Agents and skills

Subagents live in `.claude/agents/`; invoke with `@agent-<name>`. `pnpm agents:verify`
fails if this table drifts from disk.

| Agent | Purpose |
|-------|---------|
| `code-planner` | Create GitHub epics and sub-issues |
| `code-issue` | Implement GitHub issues with TDD and PR automation |
| `code-review` | Review PRs against requirements, security, coverage |
| `adversarial-reviewer` | Single-lens verifier told to *disprove* a change; dispatch 3 in parallel on security work **copying its JSON contract verbatim** (a hand-written severity vocabulary silently un-blocked a panel, #1170), tally with `pnpm review:adversarial-tally` |
| `research` | Gather and synthesize requirements from multiple sources |
| `e2e-test` | Write Playwright end-to-end tests from acceptance criteria |
| `ui-vision` | Browser walkthrough and visual QA |

Skills live once in `.github/skills/<name>/SKILL.md`, symlinked into `.claude/skills/`, so
Claude Code discovers them and loads a body only on match or on `/<name>`. **Do not `Read`
a SKILL.md to load one.** A new skill needs its symlink; `pnpm skills:verify` gates that.

**A subagent needs `Skill` in its `tools:`; the main session always has it.** `Skill` is
inherited only when `tools:` is *omitted*, and an explicit allowlist is a whitelist — so an
agent that declares one and leaves `Skill` out can still *see* `/<name>` in its slash
commands and cannot run it. Six of seven agents shipped that way (#1162, measured);
`agents:verify` now fails on "body says invoke `/x`, `tools:` has no `Skill`". Use
`tools: Skill`, **not** the `skills:` field, which preloads whole bodies eagerly and so
defeats the point.

A `tools:` allowlist naming no `mcp__*` pattern removes **every** MCP tool from that
subagent, and all seven declare one (#1146) — never write `mcp__*` instructions for an
agent that cannot reach them, **including in the skills its body tells it to invoke** (and
what those hand off to): a skill is not owned by one agent, so `agents:verify` walks the
agent→skill edge to a fixed point and fails on "no-MCP agent invokes MCP-instructing
skill" (#1180). A line genuinely addressed to the main session
carries `<!-- mcp: main-session only -->`. Only `e2e-test` and `ui-vision` list `mcp__*`
today; the rest work through `gh` in `Bash` plus whatever `WebFetch`/`WebSearch` they
declare. Servers live in `.mcp.json`.
