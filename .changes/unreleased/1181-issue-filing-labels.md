---
issue: 1181
section: Added
---

- Issue filing rule: every new issue gets a tier, an `area:` and a type label and joins the
  roadmap board via `gh issue create --project "METIS roadmap"`; the nightly roadmap sync now
  reports each open issue missing one, without failing the run.
