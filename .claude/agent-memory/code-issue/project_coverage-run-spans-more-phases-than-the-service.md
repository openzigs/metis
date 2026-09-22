# A coverage "run" spans more phases than the service that owns the cost tracker

**Found:** #82 review (issues #72/#73/#77), 2026-09-22. **Fixed in that PR.**

`server/src/lib/testcoverage/task-runner.ts` executes `import` and `index` BEFORE it calls
`runCoverageScoring`. The `index` phase is `TestCoverageIndexer.index()`, which embeds every
test-case text and every step text — on a cold 200-test corpus, more embedding tokens than the
match phase and every in-loop cache key put together.

Until #72's follow-up, `CoverageCostTracker` was constructed *inside* `runCoverageScoring`, so
none of the index phase could ever reach it. A PR could truthfully say "every embedder call the
service makes is billed" and the changelog would then say "every embedder call a run makes" —
two different claims, one of them false, and no test could tell them apart because every
coverage-service test starts after the index phase.

**The rule:** any "every call in a run is X" claim about test coverage must be checked against
`task-runner.ts`'s phase list (`import`, `index`, `match`, `judge`, `suggest`, `score`), not
against `coverage-service.ts`. The tracker is now created by the task-runner and threaded into
both `indexer.index(..., { cost })` and `runCoverageScoring(..., { cost })`; the runner flushes
it too, because with no `caller` wired the service never runs at all.

**Generalises to:** a background task-runner with a per-run accounting object. Build the
accumulator at the outermost scope that the run's phases share, or the phases outside it are
silently free.
