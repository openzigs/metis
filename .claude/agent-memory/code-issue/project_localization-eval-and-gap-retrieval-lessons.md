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
- **Hybrid (RRF-fused) scores do not compare across separate searches**: rank 1 scores the same in every search, so every project's best file lands near 0.06. #1776 (rank once per request on `fileScore`) lowered Miniflux R@5 0.52 → 0.46; cross-project or cross-change ranking needs the vector similarity score (#1784) or an LLM rerank.
- **The A4 gain survived the #1781 fix** (Sonnet, 2 runs): R@10 0.60 → 0.72, edit precision 0.17 → 0.20, R@5 flat; deepseek-flash costs less but takes ~52 s per requirement.
- **Cosine (vector) scores do compare across searches** (#1784, arm A12): ranking once per request on them raised Miniflux edit precision 0.17 → 0.30 at flat R@5. The margin trades precision against repository confinement (0.05 confines 3/14 one-repo answers; 0.01 looked like 8/14 but was found on held-out data, #1795).
- **Production's split seeding reads table precision ~0.50 vs the mapper path's ~0.69** (#1786, #1793): the impact-recall floors were measured on the mapper path, so never gate a split-seeding reading against them.
- **LLM rerank and agent citations are the first arms to raise R@5** (#1798, #1755): A13 (Sonnet rerank fused at weight 1) Δ R@5 +0.17 over 39 pooled items at ~$0.02/req; A3A (agent citations alone, deepseek-flash) +0.29, but 30–60 s/req. Appending after A0 can never raise R@5 — lead with the model's picks.
- **Every arm that calls a model must name the model in `configuration`**: the resume fingerprint and report rely on it (A3 shipped without, #1810). A DeepSeek tuning run needs `MODEL_PRICES` or it stops on the first unpriced call.
- **In measurement PRs, check the derived maths behind a stated trade-off, not just the thresholds**: #1808's thresholds were right but its reason ("cannot lift rank 6+") was false; a brute force over `fuseEditOrder` takes a minute.
