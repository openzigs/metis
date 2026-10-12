---
name: tiered-price-needs-one-requests-usage
description: computeCostCentsExact applies a prompt-length tier, so its usage must be ONE request's; a sum must be split by isLongPrompt and priced with tierRate.
metadata:
  type: project
---

`computeCostCentsExact` (`server/src/lib/finops/provider-rates.ts`) applies a prompt-length tier, so the usage passed to it must be ONE request's — code that sums tokens across calls before pricing must split by `isLongPrompt` and price each share with `tierRate`, or a run of small Haiku 5.5 calls is billed at the 5x long-prompt prices.

On #1080 (PR #1092) Claude Haiku 5.5 became the first model with such a tier: $0.10/$0.50 per MTok, or $0.50/$2.50 for a request whose prompt (uncached input + cache reads + cache writes) is over 100,000 tokens. Four calls of 30,000 in / 1,000 out cost 1.4 cents one by one and 7 cents priced as one 120,000-token request.

**Why:** the tier is decided from the usage handed in, and nothing in the function can tell a single request from a sum. A summing caller compiles, passes every single-call test and over-bills silently.

**How to apply:** before pricing, ask whether the counts are one request's. If they are a sum, do not call `computeCostCentsExact` on them. For a usage row, call `priceLedgerTokensExact` (`finops/token-tracker.ts`) with the row's requests; for an in-memory sum, group by `(provider, model, isLongPrompt)` first, as `priceRunUsage` (`replay/runs-service.ts`) and `RunUsage` (`docs-gen/run-cost.ts`) do. A test for any new pricing path needs a multi-call case whose calls are each under the threshold and together over it. Links: [[usage-row-is-not-always-one-call]].
