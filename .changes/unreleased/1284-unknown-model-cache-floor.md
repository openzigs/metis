---
issue: 1284
section: Fixed
---

- A Claude model newer than METIS's prompt-cache table still gets the docs-gen
  cache warm-up, instead of paying a cache write for every parallel batch.
- `pnpm cache:report` accepts `--since` / `--until` dates such as
  `"October 15, 2026"`; before, they matched no rows.
