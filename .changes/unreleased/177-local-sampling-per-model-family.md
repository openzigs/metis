---
issue: 177
section: Changed
---

- Local document generation now picks its default sampling from the model
  family: Gemma models keep temperature 1.0 / top_p 0.95 (the model card's
  values), and every other or unknown local model defaults to temperature
  0.2 / top_p 0.95. `DOCS_GEN_LOCAL_TEMPERATURE` and `DOCS_GEN_LOCAL_TOP_P`
  still override. Both values are always sent on local requests.
