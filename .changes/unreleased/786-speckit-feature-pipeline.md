---
issue: 786
section: Fixed
---

- `speckit.specify` and `speckit.plan` are grounded on project knowledge and code
  like `/specify` and `/plan`, use the same spec and plan contracts, and report it.
- `speckit.tasks`, `speckit.clarify`, `speckit.analyze` and `speckit.implement`
  with a `featureSlug` read and write that feature's `specs/<slug>/` artifacts
  behind its phase gate, so a feature's `tasks.md` (and `taskstoissues`) is
  reachable. Without a slug they stay project-level.
- Feature slugs and titles are cut at a word boundary, not mid-word.
