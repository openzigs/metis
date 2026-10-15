---
name: project_model-card-and-run-resolve-model-separately
description: The Model card and the analysis run resolve the model on separate paths; check Auto changes on both under combined configs
metadata:
  type: project
---

In METIS, the Model card (model-recommendation route, `server/src/routes/model-preferences.ts`) and the analysis run resolve the model through separate code paths: the route builds its own `ModelRouter` with the preferences, while the orchestrator uses `resolveRunModel` / `selectModelForAgent` (`server/src/lib/analysis/orchestrator.ts`). Any change to Auto semantics must be checked on both paths under combined configs (project `aiModel` + Models-page `defaultModel` / `taskTypeOverrides` / `budgetDowngradeThreshold`).

**Why:** on PR #1150 (#1145) the card kept applying Models-page preferences that the run silently dropped when the project set `aiModel`, so the card named a model the run never used; the adversarial panel then found router options (`acceptedModelIds`) wired at both call sites with no test at either.

- In `server/tests/analysis-orchestrator.test.ts`, `modelsSentBy` recorded `opts.model`, and non-specialist calls send `undefined` (which runs as `provider.model`), so `expect(sent).not.toContain(<provider model>)` always passed. Map `undefined` to `provider.model`. The router and budget downgrade only choose the model for `runOneAgent` specialist calls unless the run resolves the model once (PR #1150 re-review; fixed by `resolveRunModel` + `runBudgetDowngrade`).

**How to apply:** for every Auto-semantics change, write one test per path (route test + orchestrator `modelsSentBy`) for each config combination, and prove each by deleting the wiring line at that call site.
