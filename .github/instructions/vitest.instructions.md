---
description: 'Vitest unit-test conventions: tests must pass without retry, and mock state must not leak between tests'
applyTo: '**/*.test.{ts,tsx,mjs}'
---

# Vitest Conventions

## A new test must pass with `--retry=0`

`server/vitest.config.ts` sets `retry: 2`, and `ui/vitest.config.ts` does under CI. Retry
exists for I/O-timing flakes (real sockets, spawned processes, HTTP round-trips under
parallel CI load). It hides a deterministic bug just as well: PR #963 found six tests that
failed on **every** first attempt, green on CI for over a day behind a file-level tick.

- Before pushing, run the files you added or changed without retry:
  `pnpm --filter @metis/server exec vitest run --retry=0 <file>` (or `@metis/ui`).
- CI flags every test that passed only after a retry (#964): the retry reporter
  (`scripts/lib/vitest-retry-reporter.mjs`) names it, and
  `scripts/vitest-retried-tests.mjs` turns it into a **warning** annotation on a pull
  request and a **failure** on the nightly run. Locally, the same reporter prints
  `[#964] N test(s) passed only after a retry` at the end of the run. Treat either as a
  bug in the test, not as noise.

## Reset mocks, not just clear them, when a test queues once-values

`vi.clearAllMocks()` / `mockClear()` reset call history only. A queued
`mockResolvedValueOnce` / `mockReturnValueOnce` that a test did not consume **survives**
into the next test and is returned there instead of its own value. That is the #963 leak.

- If any test in a file queues `*Once` values, call `vi.resetAllMocks()` in `beforeEach`
  (or `mockReset()` on the specific mocks), then re-establish default implementations in
  that `beforeEach`.
- `vi.restoreAllMocks()` is for `vi.spyOn` spies; it is not a substitute for the above.
