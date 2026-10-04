---
issue: 855
section: Added
---

- A running documentation generation can be cancelled (`POST /docs/:docId/cancel`, or
  Cancel generation on the card or detail view). In-flight model calls are aborted, their
  spend is recorded, and finished sections are kept for a regenerate. Delete now stops a
  generating document's spend too. `DOCS_GEN_MAX_RUN_COST_CENTS` (default $25) and
  `DOCS_GEN_MAX_RUN_TOKENS` (default 20M) cap what one run may spend.
