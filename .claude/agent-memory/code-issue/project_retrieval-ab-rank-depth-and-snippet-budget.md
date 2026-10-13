---
name: retrieval-ab-rank-depth-and-snippet-budget
description: Two things a retrieval A/B hides unless asked - where a lookup that lost first rank now sits relative to callers' pool sizes, and how adding a snippet to fused hits cuts the number of symbols a token-budgeted block lists.
metadata:
  type: project
---

Two gaps the review of PR #1126 (#1072, contextual symbol documents) found after the ranking result was already in. Both were invisible in a correct, pre-registered A/B.

**1. A first-rank count cannot be weighed against the callers.** The A/B reported exact-name lookups as "ranked first: 153 of 155 before, 136 after" on pure BM25. No METIS caller takes only the first hit: they take a pool of 6 (docs-gen typed-symbol evidence), 12 (the fused blocks), 15 to 30 (`search_code_symbols`), 20 (default) or 120 (impact seeding). "17 names lost first rank" reads as alarming or as cosmetic depending on where they went, and the report did not say. When measured: 14 at rank 2, two at rank 3, one at rank 5, so nothing left any caller's pool.

- Whenever a retrieval A/B reports a top-1 count, also print the rank each lost item now holds and how many remain in each pool size the callers actually use. `--contextual-ab` does this now (`exactNameDepth`, `renderExactNameDepth` in `server/src/lib/eval/embed-retrieval/contextual-ab.ts`).
- **Search each pool at its own limit; do not read it off one deep ranking.** `HybridCodeSearch` asks the vector store for `limit * 2` candidates, so on the fused channel the top 6 of a limit-120 search is not what a limit-6 caller gets. On pure BM25 the limit only slices.
- Add it as reporting. It must not touch the bars, arms, caps or the ship rule, and the extra lookups must run after an arm is scored.

**2. A snippet on a fused hit silently lowers how many symbols fit.** `fuseCodeContext` (`server/src/lib/rag/fused-code-context.ts`) budgets the block at 1,500 tokens for 12 symbols and drops every hit after the first entry that does not fit. Before #1072 no production hit had a snippet, so an entry was one head line and all 12 fit. Giving hits a body snippet of up to 800 characters, costed together with the head, left about 6. The ADR had waved the snippet through as "changes no ranking", which was true and beside the point. Two adversarial voters found it independently by arithmetic.

- The rule now: place every head line (locator) that fits first, costed alone; spend only the remainder on snippets, in rank order; cut a snippet at a line end or leave it out. The set of symbols listed must not depend on whether any hit has a snippet. Test it against a head-only reference at many budgets.
- A caller that renders the returned `hits` itself (the analysis code agent, `symbolHitToContextChunk`) bypasses the block's budget unless the hits carry the snippet as placed. They do now.
- Anything that widens what a hit carries is a budget change. Measure "how many symbols does the default block list" alongside the ranking change, in the same PR.
- A caller that never renders a snippet should not pay for the read: `createDefaultCodeSearcher({ snippetLookup: null })` (impact seeding, docs-gen).

**Also met in that round.** Proving "the measured documents did not change" needs a byte comparison of every corpus document before and after, not the production-equals-arm identity test: that test compares two outputs of the same changed code and passes whatever the change. The dump found one corpus doc comment that a "harmless" parsing fix would have rewritten (an interior comment line containing a glob, `src/site/**`, which holds `/*`).
