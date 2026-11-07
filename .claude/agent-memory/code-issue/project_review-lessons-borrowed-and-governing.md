---
name: review-lessons-borrowed-and-governing
description: Review lessons from #1902-#1912 - filter before dedupe, check a narrowed guard for new false negatives, and verify a sibling PR is merged before accepting a skipped criterion.
metadata:
  type: project
---

Three review findings from the borrowed-citations (#1828) and governing-documents (#1866) work, 2026-11-07:

1. **Filter before you dedupe.** PR #1906 dropped borrowed rows *after* `uniqueCodeLinks` had deduplicated by (file, symbol) in confidence order. A borrowed row (0.4) beat the requirement's own semantic row (0.1) on the same code, then the filter removed it, and the chain lost a test it showed before. When a filter and a keep-the-best dedupe both apply, filter first, and add a fixture with both rows on one key.
2. **A narrowed claim regex gains false negatives.** PR #1908 fixed "passes the policy limit" and silently stopped flagging "passes the policy check/review/audit" (#1919). Run the same sentence table through main's copy and the PR's copy of `packages/shared/src/governing-wording.ts` and diff verdicts in both directions.
3. **"Sibling PR covers it" needs the sibling merged.** #1911 skipped an acceptance criterion because #1906 made it moot, while #1906 was still open. Check `gh pr view <sibling> --json state`, trial-merge the heads, and merge the sibling first.

Related: [[lance-filters-after-topk]], [[verify-issue-premise-before-copy]], [[prisma-sqlite-interactive-transactions]].
