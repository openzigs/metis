---
name: test-harness-false-greens
description: Harness patterns that hide failures — pipe-to-tail exit codes, helper-only tests, fireEvent on file inputs, parallel PRs copying a type change.
metadata:
  type: project
---

Seen 2026-09-30:
- **`cmd | tail` hides the exit code.** A `tsc --noEmit | tail -2 && git commit` chain committed and pushed a typecheck error (#606); `vitest > log; grep` with a bad log path read as a failure that wasn't. Run gate commands bare and `echo $?`, or redirect to an absolute path.
- **Helper-only tests miss wiring.** #616 moved the 207 decision into `importStatus()`; every test called the helper, so reverting both route call sites left 215 route tests green. Test through the route.
- **`fireEvent.change` on a file input always fires**, so it cannot catch "re-selecting the same file does nothing" (#630). `userEvent.upload` skips an unchanged selection, as a browser does.
- **Parallel PRs copying one type change conflict on merge** even with green CI (#624 copied #616's `MCPImportResponse` change). Run `git merge-tree --write-tree origin/main <head>` after the sibling merges.
- **A "merge-tree is clean" claim on a stacked PR goes stale as soon as `main` moves** (#1254 was clean at implementation, conflicting at review once #1249 landed). Re-run it at review time, not from the implementer's report.

**Why:** each produced a green signal for a broken or unverified state.

**How to apply:** check gate exit codes directly; add one route-level test per extracted helper; use `userEvent.upload` for file inputs; re-run merge-tree before merging a PR whose sibling just landed. Links: [[vitest-once-mocks-and-retries-hide-leaks]], [[parallel-prs-semantic-conflicts]].

## SQLite fixtures can share a `createdAt` millisecond (#1287)

Rows created in one SQLite test `beforeAll` can share a `createdAt` millisecond, so an `orderBy: createdAt` assertion is flaky. Give fixtures distinct priorities, or compare as sets.

## vitest defines `require` in ESM source (#1387)

vitest's module runner defines `require`, so no vitest test can catch `require is not defined` in `server/src`. Import the module in a plain Node ESM subprocess instead: `node --experimental-strip-types --input-type=module -e "await import(...)"`.

## Contention reads as failure (#1419)

Never start `pnpm test` while `pnpm install` or `typecheck` is still running in the
background. The scripts suite's subprocess tests (13 s each) time out from CPU contention
and look like real failures.

**More fan-out timeouts that pass alone (2026-10-23):**
`server/tests/socket-role-change-633.test.ts` (~3 s per test, #1439; untracked) and the
scripts runner tests `check-no-nul` / `verify-no-company-identifiers` (5 s, #1441). On a
loaded shared machine (load ~25) a full `pnpm test` exceeded a 590 s wrapper (#1449). Run
each package separately, and re-run timed-out files alone before calling them failures. For
the CI-side rule (cut the tie to a contended resource), see CLAUDE.md (#1379).

## Grepping the output hides the exit code too (#1468)

`pnpm -s typecheck | grep error` hid a real TS2322 that CI caught. Judge typecheck and lint by
exit code, never by grepping output. Local `pnpm typecheck` can also miss what CI's `api`
Typecheck sees in `tsconfig.test.json` (#1440, #1455): see
[[notification-writers-and-content-copies]] and [[dependency-audit-flips-on-new-advisories]].
