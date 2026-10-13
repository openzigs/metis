---
issue: 1072
section: Changed
---

- Code search now matches on a symbol's package, declaration and doc comment as well as its
  name, and each hit carries the first lines of its body. Measured before shipping: nDCG@10
  0.282 to 0.398 on 127 queries (ADR 0020). Callers, tables and the receiver were left out.
  - Existing projects pick this up on their next ingest, which embeds each code symbol again
    once (OPERATIONS §6.7). No document is regenerated.
  - Cost: an exact-name search on a project not yet embedded finds its symbol first less
    often (136 of 155 names, was 153). All 17 are still in the first five results.
  - A body snippet never displaces a symbol from a code block: every locator is placed
    first and snippets use only the budget that is left.
