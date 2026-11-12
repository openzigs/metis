---
issue: 2336
section: Added
---

- `pnpm eval:ba-qa --routing-sweep` and `--routing-scope <n> --route all|routed|oracle` measure whether multi-product chat should pick the likely projects before searching. The routing set (`routing.json`) has 20 questions over nine products. Routing was not needed: tokens and latency stay flat up to nine projects, and merging results on relevance recovers search-all's accuracy loss. Chat is unchanged.
- The BA question report gives input tokens, seconds and retrieval time per question.
