---
issue: 1611
section: Added
---

- A code citation on an analysis finding now records which of the project's repositories the cited
  file came from, so two repositories that both hold `src/auth.ts` are no longer confused. METIS sets
  it from what the analysis actually retrieved and ignores any repository the model names. Findings
  saved earlier are unchanged.
