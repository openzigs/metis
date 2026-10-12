---
name: side-column-readers-apply-writer-invariant
description: When readers re-price from a validated side-column, every reader must apply the writer's invariant check, not only a shape check (token_usages.requestTokens, #1092).
metadata:
  type: project
---

When a PR adds a validated side-column that readers re-price from (here `token_usages.requestTokens`), check that every reader applies the same invariant check as the writer (here `summedRequests`: the list must add up to the row's own token columns), not just a shape check. PR #1092 validated the sum on write and trusted the stored list on read at both readers (`budget-enforcer.ts`, `replay/runs-service.ts`); a list of two 1-token calls on a 400,000-token row priced at 0.00012¢ instead of 22.5¢.

**Why:** nothing writes such a value today, so no ordinary test shows it; only a hand-built bad row (hand edit, bad restore, backfill of the token columns) does.

**How to apply:** readers call `ledgerRowSummedRequests(row)`, never `ledgerRowRequests(row)` directly. For any new stored-and-revalidated column, write the test with a stored value that is well-formed but disagrees with its row. Related: [[usage-row-is-not-always-one-call]], [[tiered-price-needs-one-requests-usage]].
