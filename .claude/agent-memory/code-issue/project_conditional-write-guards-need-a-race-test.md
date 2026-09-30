---
name: conditional-write-guards-need-a-race-test
description: Where-unchanged race guards keep shipping untested
metadata:
  type: project
---

PR #518's backfill guarded updateMany with the row's prior values; deleting either guard clause left the suite green.

**Why:** A claimed race-safe write is unproven until a test changes the row between read and write.

**How to apply:** Mutate the extra where-clause away; require a test that interposes a concurrent write and asserts nothing is written.
