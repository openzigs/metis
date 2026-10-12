---
name: model-cannot-claims-need-engine-level-sweep
description: A "the model cannot do X" invariant proven by sweeping one pure function is only as wide as that function's inputs; check it at computeProjectImpact with every optional LLM dep on. Never bound a timing test within ~4x of its idle figure.
metadata:
  type: project
---

An invariant of the form "the model cannot do X" proven by a sweep over one pure function is only as wide as that function's inputs — in the impact engine the #791 gate's writer list is scoped by an earlier LLM stage (#936 table filter), so check every such claim at the `computeProjectImpact` level with each optional LLM dep switched on; and never give a timing test an absolute wall-clock bound within ~4x of its idle figure (a 100 ms bound went red on the CI fan-out at 102–148 ms).

**Why:** PR #1090 review 3. The gate sweep (over 1,000,000 combinations of the proposer's fields) was green and falsifiable, and the claim was still false end to end: `gateColumnProposals` was handed writers looked up for `primaryTables: affectedTables`, and by then `affectedTables` was what the #936 relevance filter had left in the primary set. One filter answer (`entries` is tangential) gave a core `users.mark_read_delay` on the verbatim #4478 text, with the reason "the SQL lineage named no write path for this request" — false, the lookup had not been asked about `entries`. No engine test set a `tableRelevanceFilter`. Same review: `change-request.test.ts` held linear code to 100 ms; idle it took about 30 ms, on the 1,455-file CI fan-out 148, 121 and 102 ms on three attempts.

**How to apply:**

- For each input of the pure function, ask who computes it in the engine and whether a model sits upstream. Then list the engine's optional LLM deps (`tableRelevanceFilter`, `tableRecoveryJudge`, `clauseCoverageReconciler`, `additiveColumnProposer`, and `mapRequirement` when the seeding flags are on) and give each an adversarial fake in an engine-level test. `impact-analysis-engine-791-llm-deps.test.ts` is the pattern: filter answers that demote, drop, duplicate and invent rows, crossed with proposer answers.
- A dep is "closed" by construction (the #1029 judge runs only when the proposer does not) or by reading an input from before the model (the gate's lookup uses the pre-filter crossing). One that cannot be closed cheaply is stated as a limit in the module header and pinned by a test: with `IMPACT_LLM_SEEDING` / `IMPACT_LLM_ENTITY_SEEDS` a model shapes the seeds, and so which tables the crossing reaches.
- State such an invariant by what a model cannot do, not by a single route ("the only route to core is `ALTER TABLE`" was wrong: `detectAdditiveColumnIntent` also reads two prose forms, and an unknown heading is a sub-section).
- Timing: use `server/tests/helpers/linear-time.ts` (`expectLinearTime`): pass when fast at full size (250 ms, the fuzz suite's bound), otherwise compare with a quarter of the size and require a ratio under 8 (4 is linear, 16 quadratic). Test the helper on a fake clock, not on the machine. Better still, remove the work: `seedQueries` now cuts the request before the replace chain, not after.
- CodeQL `js/redos` reads a deliberately slow pattern out of a test like any other. Assemble it from fragments at run time (`slowPattern` in `request-regex-fuzz.test.ts`); do not dismiss the alert or add tests to `paths-ignore`.

Links: [[project_redos-fix-ships-beside-new-pattern-fuzz-all]], [[project_deterministic-gate-over-llm-output-probes]].
