---
name: vitest-beforeeach-return-is-cleanup
description: beforeEach(() => mock.mockReset()) returns the mock, which Vitest then runs as cleanup after every test; use a block body.
metadata:
  type: project
---

Vitest treats a function returned from `beforeEach` as that test's cleanup. `beforeEach(() => canAccessThread.mockReset())` returns the mock, so Vitest called `canAccessThread()` after every test. Nothing showed until a test used a rejecting mock. That test then failed during cleanup with no assertion at fault (#685, PR #687). PR #687 fixed 30 such hooks across `server` and `ui`.

**Why:** an arrow function with an expression body returns its value, and `mockReset()` returns the mock itself.

**How to apply:** always give `beforeEach` and `afterEach` a block body, for example `beforeEach(() => { m.mockReset(); })`. Treat a "failed in cleanup" error that has no assertion behind it as a sign of this.
