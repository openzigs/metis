---
issue: 2566
section: Added
---

- Each project can now override how deeply analysis reads its code: `explore`, `fast`, or `auto`
  to follow the platform default. Set it with `PATCH /api/projects/:id/code-exploration`; the
  project's details return both the setting and what it resolves to. A repository with no clone
  on the server still runs `fast`. Each analysis records whether the project's setting or the
  platform default decided its mode.
