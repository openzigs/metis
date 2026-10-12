---
name: usage-row-is-not-always-one-call
description: A token_usages / ai_token_usages row can be the sum of several model calls (chat tool turns, discussion replies, failed turns); they pass `requests` so it is priced per call.
metadata:
  type: project
---

A `token_usages` / `ai_token_usages` row is NOT always one model call — chat tool-loop turns (`routes/ai.ts` `/chat` and `/stream`), discussion replies (`discussions/ai-responder.ts`) and failed-turn rows (`TurnUsageMeter.recordFailedTurn`) record the sum of several calls as one row. So any per-request pricing rule must be checked against every caller of `recordUsage` / `TokenTracker.record`, not only against the pricing function.

**State since PR #1092 (#1080).** Those callers still write one row per turn, and now pass each call's own usage as `requests` with the sum (`TurnUsageMeter.requests`, the responder's `ReplyMeter.requests`). `recordUsage` and `TokenTracker.record` price the row call by call, and `token_usages.requestTokens` stores the calls as a JSON array of `[input, output, cacheRead, cacheWrite]` (NULL = the row is one call). The two readers that re-price a stored row from its tokens read that column through `ledgerRowRequests`: `priceRunUsage` (`replay/runs-service.ts`) and the NULL-cost re-pricing in `projectMonthlyCostForCeiling` (`finops/budget-enforcer.ts`). `ai_token_usages` has no such column because nothing re-prices its rows.

**Why:** the first version of #1080 priced the tier per row and its consumer table said every row was one call. Review found the three summed callers; the adversarial panel did not.

**How to apply:**
- A new caller that sums calls before recording must pass `requests`, or it is priced as one request.
- A new reader that re-prices `token_usages` rows from tokens must select `requestTokens` and go through `priceLedgerTokensExact` / `ledgerTierShares` (`finops/token-tracker.ts`).
- Still priced as one request: a turn metered on an estimate because the provider reported no usage, and requests that do not add up to the row (`summedRequests` returns `null`).
- Per-call callers, checked on #1092: analysis (`meterAnalysisProvider`), docs generation, Spec Kit, impact analysis, sub-agents (`bindSubAgents`), compaction, `apply_diff`.
- A sqlite test built with `stopBefore` that then runs current readers needs `sqlite.applyRemaining()`: a later column in a `select` fails otherwise (hit in `usage-ledger-precision-761.sqlite.test.ts`).

Links: [[tiered-price-needs-one-requests-usage]].
