---
issue: 1027
section: Added
---

- Starting an analysis from a Spec Kit handoff now sends `plan.md`'s components and `tasks.md`'s
  task ids and titles as context for the code agent, apart from the requirements from `spec.md`.
  The context is never split into requirements or counted as one, has its own 4,096-character
  limit, and the analysis page lists what was sent as context and what did not fit.
