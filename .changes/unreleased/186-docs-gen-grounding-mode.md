---
issue: 186
section: Added
---

- Documentation fact-checking can be turned down for fast local test runs. `DOCS_GEN_GROUNDING=sample`
  checks a deterministic, evenly spread sample of each section (`DOCS_GEN_GROUNDING_SAMPLE_RATE`,
  default 25%, at least 10 claims per section) and `DOCS_GEN_GROUNDING=off` skips the check. Either
  way the document is marked as needing review and says it was only spot-checked or not
  fact-checked, as does every section the check did not fully cover, and the provenance records
  the mode, so it can never pass for a fully verified document. The default, `on`, checks every claim exactly as before.
