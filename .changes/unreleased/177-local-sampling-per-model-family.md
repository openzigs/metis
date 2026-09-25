---
issue: 177
section: Changed
---

- Local document generation now picks its default sampling from the model
  family: Gemma models keep temperature 1.0 / top_p 0.95 (the model card's
  values), and every other or unknown local model defaults to temperature
  0.2 / top_p 0.95. Each phase uses its own model's family, so a Gemma
  Phase 1 with a non-Gemma Phase 2 keeps 1.0 for extraction.
  `DOCS_GEN_LOCAL_TEMPERATURE` and `DOCS_GEN_LOCAL_TOP_P` still override. Both
  values are always sent on local requests. After upgrading, a local
  deployment on a non-Gemma model without those overrides misses its Phase-1
  fact cache and section reuse once, because the sampling (and so the cache
  key) changed; the next run regenerates in full.
