---
name: code-pass-placeholders-and-append-mode
description: The agentic code pass writes an uncited could-not-verify finding for every unreached requirement, so "has a code finding" is no evidence; append-mode passes must purge older rows and placeholders without dropping IssueLinks (#1451 and its reviews).
metadata:
  type: project
---

From #1451 and its review and re-review (2026-10-23).

**Placeholders.** The agentic code prompt's `VERDICT_RULE` (`server/src/lib/analysis/prompts.ts`)
makes the model write an uncited could-not-verify finding for every requirement it did not
reach. "Has a code finding" is not evidence the agent looked: use `checkedRequirementIds` or a
grounded citation. Fixtures for an unreached or cut-short code pass must include that
placeholder; fixtures with no finding hide bugs where stale findings meet the
"could-not-verify beats implemented" roll-up (`deriveRequirementVerdict`).

**Append mode.**
- `persistAgentResult` in replace mode deletes only ONE prior row per (agentKey, connector),
  via `findFirst`. Any path appending code rows must make the next replace purge all older
  ones (handled in `regenerateCodeAgent`, `analysis/orchestrator.ts`).
- An appended pass does not replace earlier findings, and could-not-verify outranks
  implemented, so an append path must delete or supersede the earlier uncited placeholders
  for the requirements it re-ran.
- Deleting a finding (Prisma model `Finding`) cascades its `IssueLink`
  (`onDelete: Cascade`), losing the published-issue link. Filter `issueLinks: { none: {} }`.

**Review heuristics.**
- In-memory Prisma mocks that filter on only some `where` fields hide a delete's limits. For
  any path deleting findings or agent results, assert the exact `where`, or drop each filter
  one at a time and confirm a test fails.
- A "trust the run's record over the saved data" rule needs a retry check: a record refreshed
  only on success is stale after a partial failure. Treat it as an upper bound.

Related: [[decided-verdicts-need-positive-evidence]], [[analysis-run-claims-and-citation-salvage]],
[[code-agent-early-stop-is-a-toolless-reply]], [[test-falsifiability-traps]].
