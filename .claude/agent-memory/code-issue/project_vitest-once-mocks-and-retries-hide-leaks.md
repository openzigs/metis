---
name: vitest-once-mocks-and-retries-hide-leaks
description: server retry:2 hides once-mock leaks, races and wrong-reason passes; check new tests with --retry=0 and assert the reason, not just the status.
metadata:
  type: project
---

On PR #452 (#448), a test queued `update.mockRejectedValueOnce(...)`. The fixed code never called `update`, so the queued rejection sat unused. `vi.clearAllMocks()` does not drop once-implementations in vitest 4.1, so the rejection fired inside the next test's `update`. `server/vitest.config.ts` has `retry: 2`, so the suite still passed. With `--retry=0` it failed 1 of 25. Separately, on #450/#459, a timing race passed on retry while the unhandled rejection it left behind still failed the run.

**Why:** retries mask both order-dependent leaks and races, and clearAllMocks resets only call history.

**How to apply:** for "this must not be called", assert `not.toHaveBeenCalled()` instead of queueing a rejection. Verify every new or changed test with `vitest run <file> --retry=0`. When a PR claims a test was red before the fix, check that the output has no `(retry x2)` pass.

Two more shapes (2026-09-30):
- **Right status, wrong reason.** On #571 (#563), the workspace invite accept route returns 410 for three reasons: expired, used and workspace deleted. With the fix reverted, attempt 1 consumed the invite, and the retry got 410 "already been used", so a status-only assertion passed. Assert the error message or code as well.
- **One-shot deferreds.** On #583 (#562), the race test gated a module-scoped `vi.hoisted` deferred that resolved once. A retry ran with the lookup already resolved and no longer exercised the race. Create the deferred per attempt, and use a barrier on the same connection: Socket.IO orders packets per connection only. The same applies to mutation checks: on #776 a mutant looked survivable because a retry passed in a SQLite suite that shared state across `it` blocks, so run mutants with `--retry=0` too.
