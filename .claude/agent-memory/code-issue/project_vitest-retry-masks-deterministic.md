---
name: project_vitest-retry-masks-deterministic
description: server vitest retry:2 hid 6 deterministic failures (mock once-value leak); clearAllMocks keeps queued once-values
metadata:
  type: project
---

`server/vitest.config.ts` sets `retry: 2`, and CI's default reporter prints only a file-level ✓, so a test that fails every first attempt but passes on retry looks green. Found 2026-10-08: 6 tests in `server/src/routes/analysis-approval-promotion.test.ts` (leak introduced by PR #902) — an `it.each` queued `mockResolvedValueOnce` for a route that never consumed it, and `vi.clearAllMocks()` in `beforeEach` does NOT drop queued once-values (vitest 5), so later tests got the previous test's result. Fixed in PR #963 with `vi.resetAllMocks()`.

**Why:** retry masks deterministic failures, not just timing flakes.

**How to apply:** verify new tests with `--retry=0`; use `vi.resetAllMocks()` (or `mockReset`) when tests queue once-values; don't trust a green file summary as proof of first-try passes.
