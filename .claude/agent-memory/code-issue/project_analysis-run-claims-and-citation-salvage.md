---
name: analysis-run-claims-and-citation-salvage
description: orchestrator claim + stop-gate release must pair; a failed finalize must mark the run failed; schema-dropped citations need per-finding marks (#1155, #1156, #1202)
metadata:
  type: project
---

- **Claim and stop gate move together** (`server/src/lib/analysis/orchestrator.ts`). Releasing an analysis claim (the `active` map) and lifting the stop gate (`stopAnalysisModelCalls` / `allowAnalysisModelCalls`) must happen together. Route every release through `releaseClaim`. A cancel during the continue check once left the next regenerate making 0 model calls (#1156).
- **Releasing the claim does not unblock a run whose finalize write failed.** Regenerate and resume refuse a row whose status is `running`, and nothing resets it on boot, so `finalizeFollowUp` marks it `failed`. If the database is down for both writes, the row still reads `running`; that needs a boot sweep, which has not been built.
- **A citation dropped by the shared schema's salvage never reaches the #734 grounding gate.** Model-boundary salvage that drops evidence must mark each finding (`citation-salvage.ts`), not only keep a run count. Only lost *code* citations demote a finding to `unverified`; document citations and cap cuts do not (#1155).
- **`promote-requirements.test.ts` mocks `./analysis-service.js` with a fixed export list.** A new helper imported from there arrives `undefined`; put pure helpers in a dependency-free module (`promotion-pairing.ts`, #1202).
- **Promotion pairing (#1202):** `requirements.promotedStructuredId` / `promotedStructuredRunId` / `promotedSynthesisKeys` are written by `persistRequirements` and `appendNewlyApproved`. Joins use them first and fall back to title matching only for older rows.

Related: [[requirement-history-writers-and-resync]], [[one-to-one-join-traps]], [[structured-req-ids-repeat]].

**From the #1264 review:**
- The `start` path sets `ActiveRun.settled` before recording its result, but regenerate and resume never do. A cancel during their finalize returns `true` and audits `analysis.cancel`, yet the run ends completed or failed.
- `clampAgentOutputStrings` (`agent-runner.ts`) mutates its argument in place. To mutation-test "count before or after the clamp", reorder the two calls; swapping `clamped` for `parsed` changes nothing.
- "Every run picker" means every list of `AnalysisListItem` that shows a status: the Workbench and Library lists too, not only the hub and Publish pickers.

**Added 2026-10-19 (#1264 cycle 2, #1267):**
- `Analysis.totalTokens` is used for more than display: `cost-cap.ts` sums it for the monthly cap and for budget routing, and neither reads the ledger. When a write may or may not have committed, settle it with a conditional `updateMany` keyed on the in-progress status and carrying the real delta (`settleRunningAnalysisAsFailed`). An unconditional retry has to choose between double-counting and dropping tokens.
- `routes/analysis.ts` fires regenerate and resume as `void …catch(() => {})`, so an error a follow-up rethrows from its `finally` must be audited before the rethrow or it leaves no trace.
- `markAnalysisFailed` / `markAnalysisCancelled` also set `completedAt`, and failed or cancelled runs can be regenerated. Since #1267, `markAnalysisRunning` keeps `completedAt` only for a run that had completed (`countsAsCompletedRun`). A re-run sets `running` before it persists requirements, so anything that reads "the run Requirements opens on" during that window has to use that rule.

- Every #706 walkthrough run stored in the local `dev.db` predates #1033's `structuredIds`, so stored data cannot measure the structured-id join; that needs a new walkthrough run (#1359).

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[structured-req-ids-repeat]] — structured req ids repeat: REQ-001 ids repeat across re-runs; scope promoted ids to run (#902)
- [[one-to-one-join-traps]] — One-to-one joins: never guess: reuse one-to-one-match.ts; mutate tiers; sparse chain
