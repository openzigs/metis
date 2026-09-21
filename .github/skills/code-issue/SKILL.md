---
name: code-issue
# Single-quoted deliberately: an UNQUOTED YAML scalar treats " #" as the start of
# an inline comment, which silently truncated this description at "Closes" until a
# session probe caught it. Quote any description containing a space then a hash.
description: 'End-to-end implementation workflow for a numbered GitHub issue or epic. Use when asked to implement, build, fix, or work an issue, epic, or sub-issue, or to take a ticket from feature branch to merged PR. Covers TDD, the 80% coverage floor, security scanning, the lint/typecheck/test gate, changelog fragments, self-review, and opening a PR that says "Closes #N". Use code-review to review a PR written by someone else.'
argument-hint: "[epic or issue number] — GitHub issue number to resolve"
---

# Code Issue Resolver

## Purpose

This skill drives the **Code Issue** agent through a complete development workflow to resolve GitHub epics and their sub-issues. It orchestrates branching, test-driven development, security scanning, CI validation, and pull request creation — all autonomously with self-review checkpoints.

## When to Use

- The user asks to "work on issue #N" or "resolve epic #N"
- The user wants to implement a feature or fix described in a GitHub issue
- The user says "start coding", "pick up the next issue", or "implement this"
- There is an epic with multiple sub-issues to complete in sequence

## Agent

This skill should be executed by the **Code Issue** agent (`.claude/agents/code-issue.md`).

**It has no MCP tools.** Its `tools:` allowlist names no MCP pattern, and an allowlist
that names none strips every MCP tool from the agent (#1146, measured). So every step
below is written in the tools it actually holds — and `gh` is the *primary* path
throughout, not a failure branch (#1180):

- **`gh` and `git` in `Bash`** — issues, PRs, branches, pushes, CI status
- **`WebFetch` / `WebSearch`** — library docs and reference material
- **`Read` / `Write` / `Edit`** — the working tree
- **`Agent`** — dispatch `e2e-test` (which declares an MCP allowlist and holds Playwright)
  for browser work

The main session, and any agent declaring an `mcp__*` pattern, may use the MCP equivalents instead.

## Workflow Overview

```
┌─────────────────────────────────────────────────┐
│  1. PLAN — Read issue, analyze codebase, plan   │
├─────────────────────────────────────────────────┤
│  2. BRANCH — Create feature branch from main    │
├─────────────────────────────────────────────────┤
│  3. IMPLEMENT — For each sub-issue:             │
│     a. Write tests (TDD)                        │
│     b. Implement code                           │
│     c. Run tests (≥80% coverage)                │
│     d. Lint and fix                             │
│     e. Self-review checklist                    │
│     f. Ask about e2e tests (if UI)              │
├─────────────────────────────────────────────────┤
│  4. SECURITY — Scan for CVEs, OWASP, vulns      │
├─────────────────────────────────────────────────┤
│  5. CI — Run CI tasks, ensure lint + tests pass │
├─────────────────────────────────────────────────┤
│  6. DELIVER — Commit, push, create PR           │
│     • Include "Closes #N" for all issues        │
│     • Add inline review comments                │
├─────────────────────────────────────────────────┤
│  7. HANDOFF — Present results, wait for review  │
└─────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Planning

1. Read the epic/issue **in full**:
   ```bash
   gh issue view {ISSUE_NUMBER} --json number,title,body,labels,state,comments
   ```
   Plain `gh issue view {N}` prints only a comment *count*; ask for `comments`
   explicitly, because that thread is where scope changes and corrections live.
2. If it has sub-issues, read each one to understand full scope:
   ```bash
   gh issue view {SUB_ISSUE_NUMBER} --json number,title,body,labels,state
   ```
3. Use `WebFetch` / `WebSearch` for any library or API question
4. Use `WebFetch` to pull reference documentation or examples
5. **Consult the graphify knowledge graph first.** If `graphify-out/GRAPH_REPORT.md` exists at the repo root, read it before any wide grep/file_search sweep — it is a precomputed summary of the entire codebase and saves tokens. Then use `graphify query "<terms>" graphify-out/graph.json` to get a token-bounded subgraph for the area you'll touch (function/class/file dependencies, imports, callers). Use `graphify path <fileA> <fileB>` to understand reach when changing shared modules. Fall back to grep only for files modified after the graph was built (check `graphify-out/manifest.json` mtime vs. `git log -1 --format=%ct -- <file>`).
6. Analyze the codebase — identify affected files, patterns, and conventions
7. Create a task tracking list with all issues to resolve

### Step 2: Branch Setup

1. Ensure working directory is clean: `git status`
2. Switch to `main` and pull latest: `git checkout main && git pull --ff-only origin main`
3. Create feature branch: `feature/issue-{number}-{short-description}`
4. Push the branch to establish remote tracking: `git push -u origin {branch-name}`

#### Resuming an Existing Branch (Merge Conflict Handling)

If the feature branch already exists (resuming interrupted work) and has fallen behind `main`:

```bash
git checkout feature/{branch-name} && git fetch origin && git merge origin/main
```

- **Clean merge** → continue
- **Conflicts detected** → resolve systematically:
  1. List conflicted files: `git diff --name-only --diff-filter=U`
  2. Read each conflict — understand both the incoming (`main`) and current (feature) change before resolving
  3. Resolution strategy:
     - Foundation/infrastructure changes from `main` → prefer `main`
     - New feature code → preserve feature branch intent
     - Logic conflicts (both sides modified the same function) → merge the intent of both, ask the user if behaviorally ambiguous
  4. Stage resolved files and complete: `git add {files} && git merge --continue`
  5. Run the full test suite to verify: `pnpm test`
  6. If tests fail after merge, fix the regressions before proceeding

### Step 3: Implementation Loop

**For each sub-issue** (or the main issue if there are no sub-issues):

#### 3a. Test-Driven Development
- Write failing unit tests that verify the expected behavior
- Implement the minimum code to make tests pass
- Run the full test suite with coverage: `pnpm test:coverage`
- **Verify ≥80% coverage** across statements, branches, functions, and lines
- If any metric is below 80%, write additional tests until the gate passes
- This is a **hard gate** — do not proceed to delivery with coverage below 80%
- Use `WebFetch` / `WebSearch` when unsure about API usage

#### 3b. Lint & Format
- Run the project's linter (`eslint`, `checkstyle`, etc.)
- Fix all errors and warnings — do not suppress them
- Run the formatter if configured

#### 3b-bis. Language conventions

Read the instruction file for each language you touched — they are the repo's conventions
of record, and Copilot applies them automatically by glob while Claude Code does not:

| Touching | Read |
|----------|------|
| TypeScript / Next.js / Tailwind (`**/*.ts`, `**/*.tsx`, `**/*.css`) | `.github/instructions/nextjs-tailwind.instructions.md` |
| Go (`**/*.go`, `go.mod`) | `.github/instructions/go.instructions.md` |
| Python (`**/*.py`) | `.github/instructions/python.instructions.md` |
| Playwright specs (`e2e/**/*.ts`) | `.github/instructions/playwright-typescript.instructions.md` |
| Anything (review standards) | `.github/instructions/code-review-standards.instructions.md` |

#### 3c. Self-Review Checklist
Before proceeding, verify:
- [ ] No unused variables or imports
- [ ] No hardcoded secrets, credentials, or API keys
- [ ] Code follows existing project conventions
- [ ] Error handling at system boundaries
- [ ] Tests cover happy path, edge cases, and error cases
- [ ] No TODO/FIXME comments left unresolved
- [ ] `docs/ARCHITECTURE.md` updated (if architectural changes made)
- [ ] `docs/USER_GUIDE.md` updated (if user-facing changes made)

#### 3d. UI Consideration
If the issue involves UI changes:
- Ask the user: *"This issue includes UI changes. Would you like me to create Playwright e2e tests?"*
- If yes, dispatch the `e2e-test` agent (it holds the Playwright MCP tools) or write the Playwright specs directly under `e2e/`
- Verify visual correctness using browser dev tools if applicable

### Step 4: Security Scan

Before creating the PR, perform a comprehensive security review:

1. **Dependency audit**:
   - Run the package manager audit: `timeout 30 pnpm audit --audit-level=moderate` (pnpm workspaces — never use `npm audit`, it hangs without `package-lock.json`), `gradle dependencies` (Gradle), or `mvn dependency:check` (Maven). If audit times out after 30s, proceed — do not block on it.
   - **Deep scan with osv-scanner** (optional — skip if not installed or if it times out):
     ```bash
     which osv-scanner && timeout 60 osv-scanner scan source --format json -r . 2>&1 | head -100 || echo 'osv-scanner not installed or timed out — skipping'
     ```
     If osv-scanner is not installed or exceeds 60 seconds, skip this step — `pnpm audit` is sufficient.
   - For any CVE IDs returned by `pnpm audit`, look up the full record via the OSV.dev REST API (no auth required, no Docker):
     ```bash
     curl -s --max-time 10 https://api.osv.dev/v1/vulns/CVE-XXXX-XXXXX | jq '{id: .id, summary: .summary, severity: .severity}'
     ```
   - To check a specific package+version for known vulns:
     ```bash
     curl -s --max-time 10 -d '{"package":{"name":"PACKAGE","ecosystem":"npm"},"version":"VERSION"}' https://api.osv.dev/v1/query | jq '.vulns // [] | length'
     ```
   - **Severity gate**: Flag any finding with CVSS ≥ 7.0 as High/Critical — these **block the PR**. CVSS 4.0–6.9 (Medium) are noted but do not block unless exploitable in context.
2. **Static code analysis** — Review all changed files for:
   - SQL injection, XSS, CSRF
   - Insecure deserialization
   - Path traversal
   - Hardcoded credentials
   - Insecure crypto
   - OWASP Top 10 issues
3. **Report to user** — Present findings with severity and suggested fixes
4. **Apply fixes** — Fix all identified vulnerabilities and re-run tests

### Step 5: CI Validation

1. Check for CI configuration (`.github/workflows/`, `Jenkinsfile`, etc.)
2. Run CI tasks locally where possible
2. Verify: all tests pass, linter clean, **coverage ≥80% (run `pnpm test:coverage` and check the summary table)**
3. **Check remote CI status** after pushing: `gh pr checks {PR_NUMBER}`. If ANY job is failing — even failures that pre-date this PR — fix them. We do not merge into a red pipeline. Pre-existing failures (e.g., type errors in unrelated files) must be resolved in this branch as a prerequisite to approval.

### Step 5.5: Adversarial Review Panel (security-relevant changes)

Self-review — Step 3c — has a structural ceiling: the agent that decided an approach was
correct is the worst candidate to decide whether it is. For changes that touch security or
authorization, a separate panel attacks the change before it becomes a PR. **The agent that
finds is never the agent that judges.**

Full workflow: `.github/skills/adversarial-review/SKILL.md`.

1. **Decide — in code, not by judgement.** `shouldRunAdversarialPass` in
   `scripts/lib/adversarial-tally-core.mjs` takes the changed paths, labels and PR title and
   returns `{ required, reasons }`. It fires on auth modules, middleware, route handlers,
   permission/role logic, session and identity handling, secrets and crypto, SSRF and
   sanitisation guards, rate limiting, tenant/project scoping, and schema migrations. If it
   is not required, record that and go to Step 5.6.
2. **Dispatch three `adversarial-reviewer` agents in a single message** so they run in
   parallel — one per lens:
   - `over-blocking` — does this refuse work it should allow?
   - `test-falsifiability` — would a test actually fail without the fix?
   - `instruction-correctness` — was an instruction followed that was wrong?
   Give each `isolation: "worktree"` so no voter reads another's mutations:
   `test-falsifiability` reverts the change in place, and on #1275 two of the panel's four
   objections were artefacts of that sweep rather than defects of the diff (#1277).
   Same dispatch for each apart from the lens slug. Do not tell a voter what you expect, do
   not relay another voter's verdict, and do not paste your own reasoning in. A panel of
   agreeable voters is worth nothing. **If you restate the output format at all, copy the
   JSON contract from `.claude/agents/adversarial-reviewer.md` verbatim — never invent a
   severity vocabulary.** `blocking` and `advisory` are the only two the tally accepts; a
   hand-written `blocking|major|minor` prompt is what caused #1170.
3. **Tally outside the model.** Collect the three JSON verdicts into an array and run
   `pnpm review:adversarial-tally <file>`. Do not summarise the panel yourself — a model
   grading its own panel can launder an uncited hunch into a blocker, or miss that a lens
   never reported.
4. **Act on the outcome — and read `Malformed input:` before you trust it.** `BLOCKED` (a
   cited, blocking objection) → fix and re-run. `INCOMPLETE` (a lens missing or duplicated,
   **or input the tally could not parse**) → fix the input or re-dispatch; it is **not** a
   clean result. `ADVISORY` → fix, or answer each objection in the PR body. `CLEAR` →
   proceed, unless the summary line reports discarded objections, which is a suspicious
   clean rather than a clean.
5. **Record it in the PR body regardless of outcome**, naming the lenses and what each voter
   checked. An empty panel is a legitimate result and reporting it honestly is the only way
   to learn whether this step earns its cost.

> **An objection with no `file:line` citation is discarded by the tally** and cannot block.
> It is still printed, so a voter producing only hunches stays visible. This is
> precision-first, and it is deliberately the opposite of the recall-first rule that governs
> the *product engine's* finding verification (epic #1107) — do not carry one into the other.
> A citation may carry a trailing description (`scripts/x.mjs:66 — the filter`); it must
> still *begin* with `path/to/file.ext:line`.

### Step 5.6: Update Living Documents

After implementation and before creating the PR, update the project's living documents if they exist:

#### `docs/ARCHITECTURE.md`
Update if this issue introduced:
- New modules, services, or components
- New API endpoints or data models
- Changes to the system architecture or data flow
- New dependencies or integrations
- Infrastructure or deployment changes

**What to update**:
- Add new components to the architecture diagram (Mermaid)
- Update the project structure section
- Document new API endpoints with request/response contracts
- Update the data model section if schema changed
- Add entries to the technology stack table if new deps added

#### `docs/USER_GUIDE.md`
Update if this issue introduced:
- New user-facing features or pages
- Changes to existing user workflows
- New configuration options
- New CLI commands or scripts

**What to update**:
- Add new feature documentation with screenshots/examples
- Update getting started instructions if onboarding changed
- Document new configuration options with defaults
- Update the FAQ if common questions are anticipated

#### `.github/copilot-instructions.md`
Update only when changes affect how a future agent would navigate or build this repo. Trigger conditions:

| Change Type | Example | Update? |
|---|---|---|
| New top-level module or service | Added `src/payments/` | ✅ Update Project Layout + Architecture |
| New build/test/run command | Added `npm run migrate` | ✅ Update Build & Run Commands |
| New coding convention established | Adopted Zod validation everywhere | ✅ Update Coding Conventions |
| New major dependency with unusual setup | Added Playwright, Redis | ✅ Update Known Gotchas |
| New CI check or lint rule | Added type-check step to CI | ✅ Update CI / Validation Pipeline |
| Routine bug fix or small feature | Fixed a null check | ❌ Skip — no structural change |
| Test added for existing logic | Added unit test | ❌ Skip |

**What to update** (surgical edits only — keep file under ~150 lines):
- Update the relevant section(s) in place
- Do **not** rewrite the entire file
- Add gotchas only if you hit non-obvious issues during the implementation
- End with: `<!-- Last updated: {date} by Code Issue agent resolving #{issue-number} -->`

> **Rule**: If `.github/copilot-instructions.md` does not exist, skip this step — it is created by the Code Planner agent during project setup. Do not create it here.

> **Why this matters**: `copilot-instructions.md` is automatically injected into every Copilot Chat request, Copilot code review, and Copilot coding agent session for this repo. Keeping it accurate means future agents (and humans) don't need to re-explore the codebase from scratch.

> **Rule**: If `docs/ARCHITECTURE.md` or `docs/USER_GUIDE.md` do not exist, skip those sections. These documents are created by the Code Planner agent during project setup.

### Step 5.7: Agent memory — write it, then **commit** it

`.claude/agent-memory/code-issue/` is **tracked in git** and is the only channel by which
one agent hands a hard-won diagnosis to the next. It demonstrably works: #1110's agent
recorded that adding a named export to `server/src/lib/analysis/synthesis.ts` breaks ~48
tests across 7 files (ten pipeline tests `vi.mock` it exposing only `runSynthesis`) — and
#1111, #1116 and #1136 were each handed that warning and **none of them hit it** (#1147).

**A memory you do not commit does not exist.** When you run in an isolation worktree
(`.claude/worktrees/agent-*`), your memory directory is inside that throwaway tree. One
agent wrote its memory there and left it: `pnpm worktrees:prune` would have deleted it, and
it had to be rescued by hand into PR #1140.

So, before Step 6 — and *especially* before unlocking or leaving a worktree:

```bash
git status --porcelain -- .claude/agent-memory   # must be empty when you finish
git add .claude/agent-memory && git commit -m "docs(memory): <what a future agent needs>"
```

Include the memory files in your PR — they are part of the deliverable, not scratch work.
`pnpm worktrees:prune` now refuses (without `--force`) to delete a worktree holding
uncommitted agent memory and prints the pending paths, but that is a backstop for a mistake,
not the workflow.

Write a memory when a diagnosis was **expensive and non-obvious** — a failure mode a future
agent would rediscover the hard way. Do not record what the code, `git log` or `CLAUDE.md`
already says.

**The index is a shared, hard-limited budget — spend your line, not everyone's.**
`MEMORY.md` is the only file loaded on every dispatch, through a path that truncates at
~25,000 bytes **without erroring**: past that the *whole* index stops being read and every
dispatch starts blind while believing it has recall. So `pnpm agents:verify` fails a store
whose index exceeds **17,500 bytes** (70% of that limit) or whose any one entry exceeds
**150 bytes**, and warns from 15,750. The index reached 24,443 bytes — 543 short of
unreadable — growing **~240 bytes per entry added** (+3,847 bytes in a single day), with a
hand-compaction six days earlier already undone (#1206).

Two consequences for you:

- **Your index line is one hook, under 150 bytes.** The reasoning belongs in the memory
  file it points at, which is read on demand and is not budgeted. The index is a **flat list
  of pointers**: a nested sub-bullet and a `---` rule both parse as bullets and both fail.
- **When the index is full, retire — never delete.** Move superseded pointers into the
  store's `ARCHIVE.md`, which is not loaded into context; the file stays on disk and the
  gate resolves index and archive pointers together. Every file in the store — any
  extension, symlinked or not, at any depth, dot-files aside — must be named by **exactly
  one** of the two, in both directions: on disk and in neither is loaded by nothing (which
  has already cost a duplicate dispatch), and in both is not retired at all.

**You are also the receiver for agents that cannot persist their own.** `code-review` and
`ui-vision` hold `disallowedTools: Write, Edit` and deliberately have no `memory:` scope
(#1163), so they end their reports with **`Durable finding:`** lines instead. If a dispatch
you made returns one, it is yours to write into this store and commit — otherwise the channel
has no receiver and the finding dies with the subagent's context.

The finding lands in the **dispatcher's** store, which is this one — never in a store owned by
the agent that found it. So a reviewer never reads its own findings back; the consumers are
future *implementers*, which is why `code-issue`'s store is the right destination and why the
line should be rewritten into something an implementer can act on rather than filed verbatim.
When the **main session** dispatches a reviewer directly there is no `code-issue` in the loop
at all (#1145), so `CLAUDE.md` names the receiver for that path; `pnpm agents:verify` fails if
that instruction ever goes missing (#1168).

### Step 6: Delivery

0. **Write the changelog fragment** — one file at `.changes/unreleased/<issue>-<slug>.md`
   carrying `issue:` and `section:` frontmatter and the entry as markdown bullets. **Never
   edit `CHANGELOG.md`**: every PR appended at the same anchor, so parallel PRs conflicted
   by construction — one PR hit the same conflict three times in a single fan-out, and a
   dirty PR schedules zero CI (#1191). Format: [`.changes/README.md`](../../../.changes/README.md).
   An entry is **a few lines**; the detail belongs in this PR body and the issue. Confirm
   with `pnpm changelog:verify`, which also runs in CI.
1. Stage all changes: `git add -A` — and confirm
   `git status --porcelain -- .claude/agent-memory` is empty (Step 5.7)
2. Commit with conventional message: `feat: [Issue #N] description` or `fix: [Issue #N] description`
3. Push branch to origin
4. Create the PR with `gh pr create`, passing the body as a **file**:
   ```bash
   cat > /tmp/pr-body.md <<'EOF'
   ## Summary
   ...

   Closes #{issue-number}
   EOF
   gh pr create --title "feat: Resolve #{issue-number} — {description}" \
     --body-file /tmp/pr-body.md --base main
   ```
   - **`--body-file`, never `--body "$(cat ...)"`.** Command substitution re-scans the
     heredoc, so any backtick in the body — and a PR body is mostly backticked
     identifiers — executes as a command.
   - The body must include: a summary of all changes, `Closes #N` for **every**
     resolved issue, the coverage summary, and the security scan result.
5. Add inline comments only if a specific line needs one — the review-publishing form
   (single JSON payload via `gh api --input`, plus the `422` self-approval fallback) is
   documented once, in `.github/skills/code-review/SKILL.md` Step 9. Do not reinvent it.

### Step 6.5: CI Verification

**There is no CodeQL workflow in this repository.** `.github/workflows/codeql.yml` does not
exist, so `Analyze (javascript-typescript)` and `CodeQL` never appear in `gh pr checks` and
waiting for them means waiting forever. This step used to say the opposite and gate handoff
on two jobs that cannot run — the fourth copy of a stale CI claim found in one audit (#1282).
The static-analysis that *does* run on a PR is **`Semgrep`** and **`Dependency audit`**.

1. **Wait for checks to complete.** `gh pr checks {PR_NUMBER} --watch` blocks, but it has
   exited 0 with jobs still pending and can return a transient empty set — so finish with a
   plain `gh pr checks {PR_NUMBER}` re-read.
2. **Require the full set present with zero pending.** Today that is **twelve** checks —
   `api`, `api-outcome`, `changelog`, `generative-e2e`, `postgres-adapter`,
   `postgres-migrate-deploy`, `sql-lineage`, `ui`, `e2e`, `windows`, `Dependency audit`,
   `Semgrep`. A run showing only two or three is **queued, not green**. Do not check that
   list off from memory: it drifts, which is the whole reason this paragraph was wrong.
   Read the set the command returns.
3. **If `Semgrep` flags something**, fix the code — a suppression comment is not a fix:
   - **Path injection**: `path.resolve()` + `startsWith(allowedBase + "/")` containment
   - **SSRF**: validate URLs against a hostname allowlist; validate user slugs with a strict regex
   - **Missing rate limiting**: add `express-rate-limit` middleware
   - **Incomplete string escaping**: handle every special character for the context (HTML, SQL, shell)
   - **Uncontrolled data in a path**: sanitize + resolve + containment check, never regex alone
   - **Non-literal `RegExp`**: build the pattern from a literal rather than a variable
4. **Read `api-outcome` before debugging a red `api`.** `api` queues on a ref-independent
   concurrency group, so a superseded run reads red having built nothing; `api-outcome`
   passes on a supersede and fails only on a genuine failure. Re-run the job rather than
   "fixing" anything.
5. **If lint, test or build fails**, fix it — including a failure that pre-dates this PR.

> **Hard gate**: Do not proceed to Step 7 until every check in the returned set is green.

### Step 7: Handoff

Present to the user:
- **PR link**
- **Issues to close** — numbered list
- **Coverage** — statement/branch/function/line percentages (all must be ≥80%)
- **Security** — clean scan or findings with status
- **CI status** — every check in the set `gh pr checks` returned, named and passing

Then state:
> **PR created and self-reviewed. All issues listed for closure. Please review. Type 'Next' when ready for the next epic.**

## Example Invocation

```
@Code Issue resolve epic #42
```

```
Work on issue #15 — it has 4 sub-issues
```

```
Pick up where we left off on epic #42, starting from sub-issue #45
```

## Error Recovery

| Scenario | Action |
|----------|--------|
| `git push` rejected (non-fast-forward) | `git fetch origin && git merge origin/main`, resolve, re-run the gate, push |
| `gh pr create` fails with a body error | Use `--body-file`; a `$(cat ...)` body executes its own backticks |
| Tests fail after implementation | Debug, fix, and re-run |
| Security scan finds CVEs | Present to user, suggest fixes, apply |
| CI task fails | Read logs, fix issues, re-run |
| Issue is unclear or blocked | Ask user for clarification |

## Shell Execution Rules

**Critical — follow these to avoid orphaned terminal tabs in VS Code:**

1. **Batch commands** — chain multiple commands in a SINGLE `execute` call using `&&`. Never create a new shell invocation for each command.
   ```bash
   # CORRECT — one execute call
   pnpm lint && pnpm typecheck && pnpm test
   
   # WRONG — three separate execute calls
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

2. **No watch mode** — never run watch or interactive commands. Always enforce one-shot execution:
   - `pnpm test` → already configured as `vitest run` in this repo (exits cleanly)
   - `pnpm test:watch` → NEVER use this in agent workflows
   - `jest --watch` → use `jest --run` instead
   - `webpack --watch` → use `webpack --mode production` instead
   - `nodemon` → spawn via tsx/node directly instead

3. **No background processes** — never use `&`, `nohup`, or `disown` to background a process. Each command must run to completion before continuing.

4. **No interactive sessions** — never launch interactive REPLs (`node`, `python`, `psql`, `sqlite3` without `-c`). Use one-shot variants with command flags.

5. **Prefer `execution_subagent`** — when you need to run a command and see its output to make a decision, prefer using the `execution_subagent` tool over the `execute` tool where available. `execution_subagent` is non-interactive and always exits.

6. **CI quality gate** — always run the gate as ONE batched call:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && cd ui && npx next build
   ```

## Prerequisites

- Git configured with push access to the repository
- GitHub CLI (`gh`), authenticated — the primary GitHub interface for this agent, not a fallback
- Project test runner configured (Vitest, Jest, JUnit, etc.)
- Project linter configured (ESLint, Checkstyle, etc.)
