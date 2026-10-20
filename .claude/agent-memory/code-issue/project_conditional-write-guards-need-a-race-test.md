---
name: conditional-write-guards-need-a-race-test
description: Where-unchanged race guards keep shipping untested
metadata:
  type: project
---

PR #518's backfill guarded updateMany with the row's prior values; deleting either guard clause left the suite green.

**Why:** A claimed race-safe write is unproven until a test changes the row between read and write.

**How to apply:** Mutate the extra where-clause away; require a test that interposes a concurrent write and asserts nothing is written.

## A coalescer that shares one field with the running request (#1287 c2)

If a coalescer keeps the next run's options in the same field as a first run that has not started yet, it loses the first request when a second one arrives before the loop's first `await` resolves. This happened at `await incremental` in `approved-requirements-staleness.ts`. To probe for it, fire two different requests in the same tick.
