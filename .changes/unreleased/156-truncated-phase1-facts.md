---
issue: 156
section: Fixed
---

- A module's fact extraction that is cut off by the model's output limit is
  retried once with a larger limit and never cached as complete; if it is still
  cut off, the document warns and names the module. Rows cached before this fix
  can be removed with `pnpm --filter @metis/server facts:purge-truncated`.
