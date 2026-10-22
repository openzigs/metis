---
name: linearity-tests-count-work-or-thread-cpu
description: Linear-time tests must count work or read thread CPU time, never wall-clock, or the monorepo fan-out fails them (#1419, #1422/#1423); a work counter needs a CPU-time backstop; keep the inputs small.
metadata:
  type: project
---

From #1419 and #1423 (which resolved #1422) and its review (2026-10-22). Checked on `main`
at 704868d0.

**The flake.** `balanced-json.test.ts`'s "stays linear … separated by prose" was a
wall-clock ratio test. It failed under the full `pnpm test` fan-out (56 ms against a 49 ms
bound) and passed alone: a #1379-shaped flake. Don't re-run it away; change the clock.

**The fix.** Node 22.22's `process.threadCpuUsage()` is available and typed. Pass
`threadCpuMs` (`server/tests/helpers/linear-time.ts`) as `expectLinearTime`'s clock, so a
regex linear-time check measures the work, not the time spent waiting for a core. Under
this repo's vitest `pool: "forks"` (`server/vitest.config.ts`), `process.threadCpuUsage()`
reads the test's own thread. CPU-clock ratios still separate a quadratic regex (~15) from
the bound (8). Where the code is ours to instrument, count the work instead
(`balanced-json.ts`'s `onWork`).

**A work counter is blind to work it doesn't count.** Per-iteration work that does not
increment the counter passes a counted linearity test. Pair it with a coarse
`expectLinearTime(..., threadCpuMs)` backstop, or a rule that every loop must count
(#1423 review).

**Keep work-count tests small** (2k/20k inputs). A quadratic mutation timed on the wall
clock takes 60-140 s per test, which looks like a hang when you mutation-check.

Related: [[model-cannot-claims-need-engine-level-sweep]] (the original `expectLinearTime`
rules), [[recursion-audit-must-bound-work-not-depth]].
