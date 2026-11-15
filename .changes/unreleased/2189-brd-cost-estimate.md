---
issue: 2189
section: Added
---

- The Generate Documentation form now shows what a Business Requirements document is estimated
  to cost before you start it, as a range, for the whole project, one repository or path
  prefixes. It counts the modules the run reads (fewer when facts were extracted by an earlier
  run), the document's sections and the configured AI models' prices. When a model has no
  price, the form names it instead of showing $0, and a run on self-hosted models says it has no
  per-token cost. The range held the cost of all 16 measured runs it was checked against,
  including the #1749 fixture run.
