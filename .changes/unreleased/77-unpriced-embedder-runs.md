---
issue: 77
section: Fixed
---

- A test-coverage run on an embedding model METIS has no price for is no longer stopped before it
  starts. Embedding is a run's first recorded usage, so treating an unpriced embedder the way an
  unpriced judge or suggestion model is treated ended every run on a Cohere model, an Azure
  deployment name, or an OpenAI-compatible endpoint. Its tokens are still reported as unpriced — the
  budget line still reads `$x + N unpriced tokens` — and unpriced judge and suggestion spend still
  stops a run. Pricing the model (Admin → `MODEL_PRICES`, key `embed:<backend>:<model>`) puts it back
  on the budget.
