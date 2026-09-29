---
issue: 282
section: Changed
---

- Documented that the Bedrock gateway's 1.25x cache-write premium cannot be priced: the
  gateway reports cache reads but discards cache writes, and folds the written tokens into
  `prompt_tokens`. METIS bills them once at the input rate.
