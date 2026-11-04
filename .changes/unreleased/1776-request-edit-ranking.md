---
issue: 1776
section: Added
---

- `IMPACT_REQUEST_EDIT_RANKING` (off by default): Impact Analysis can rank the files to edit once
  per request, across every extracted change and project, instead of up to five per change per
  project. A file that falls out is listed under Related and still seeds the blast radius.
  Measured as arm A11 of `pnpm eval:localization`: it lowered Recall@5 on the held-out Miniflux
  set, so it stays off.
