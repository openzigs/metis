---
name: localization-eval-and-gap-retrieval-lessons
description: Review lessons from #1753 (localization eval harness, PR #1769) and #1763 (portfolio per-repo search budget, PR #1768) for epics #1751/#1752.
metadata:
  type: project
---

**Eval harness spend (#1753, follow-up #1770).** In `server/src/lib/eval/localization/`, any spend outside the per-item loop (the table-precision guard, post-run measurements) must also be checked against the dollar cap. A response or stream that reports no usage is UNPRICED and must stop the run, never be metered as $0. Later arms #1754–#1761 inherit the runner, so fix these before the first paid Sonnet run. Decision runs use `claude-sonnet-5-5` (production model, owner 2026-11-04); DeepSeek is for harness iteration only.

**Eval power.** Per-corpus comparisons need about 20–28 points (Miniflux, n=25) and 26–36 points (fixture portfolio, n=15) to be significant. On the fixture corpus, A0 names all 10 files on every item, so R@10 is 1.00 by construction. Don't claim a gain there without a pooled comparison. The held-out rewrites are AI-written; until a person sets `reviewedBy`, no gain claim stands.

**Portfolio gap retrieval (#1763, follow-up #1771).** Splitting the search per project does not separate repos that share a project: `FederatedSearchService` has no per-repo or document filter, so same-project crowd-out survives any fixed over-fetch. When a fixture tests crowd-out, check where it puts the starved repo's hit relative to k. The #1763 test passes with the hit ranked 31st of 48; put it past k to prove the fix.

**Batch of 2026-11-04 (#1773, #1774, #1778):**
- **Every parser emits a `module` symbol spanning line 1 to EOF**, so a "the line is inside a symbol of that file" check passes almost any line unless it excludes `module` (as `resolveHybridSeeds` does). #1778's verifier missed this (#1781); any LLM-claim check against the graph must exclude it.
- **A stacked PR conflicts once its base PRs are squash-merged.** Do not merge `main` into it: rebuild it as `origin/main` plus the issue's own commit(s) (`git log origin/main..<branch>` shows them), then `git push --force-with-lease=<branch>:<old-sha>`. #1778 went from 52 files to its own 18.
- **The A0 baseline after the owner review (24 Miniflux items):** R@5 0.52, R@10 0.60, edit precision 0.17. Additive arms (A2 links, A4 verifier) cannot raise R@5 because they append after A0's ~7.2 picks; #1776 (rank once per requirement) targets that.
