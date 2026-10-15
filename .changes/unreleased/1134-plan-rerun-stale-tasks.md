---
issue: 1134
section: Fixed
---

- Re-running `/speckit.plan` on a feature that already has a `plan.md` now gives the model the
  previous plan as its starting point, so an unchanged spec no longer gets a new design by chance.
  The result says whether the endpoints, files or functions differ from the previous plan.
- `tasks.md`, `analysis.md` and checklists record the `plan.md` version they were generated from.
  When `plan.md` gets a newer version, the feature page marks each one out of date and names that
  version, and `/speckit.implement` warns when `tasks.md` predates the current plan.
