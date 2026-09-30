---
name: vitest-once-mocks-and-retries-hide-leaks
description: An unused mockRejectedValueOnce survives clearAllMocks and fails a later test; server retry:2 hides it. Check new tests with --retry=0.
metadata:
  type: project
---

On PR #452 (#448), a test queued `update.mockRejectedValueOnce(...)`. The fixed code never called `update`, so the queued rejection sat unused. `vi.clearAllMocks()` does not drop once-implementations in vitest 4.1, so the rejection fired inside the next test's `update`. `server/vitest.config.ts` has `retry: 2`, so the suite still passed. With `--retry=0` it failed 1 of 25. Separately, on #450/#459, a timing race passed on retry while the unhandled rejection it left behind still failed the run.

**Why:** retries mask both order-dependent leaks and races, and clearAllMocks resets only call history.

**How to apply:** for "this must not be called", assert `not.toHaveBeenCalled()` instead of queueing a rejection. Verify every new or changed test with `vitest run <file> --retry=0`. When a PR claims a test was red before the fix, check that the output has no `(retry x2)` pass.
