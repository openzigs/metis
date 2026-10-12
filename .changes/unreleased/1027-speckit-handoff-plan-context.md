---
issue: 1027
section: Added
---

- Starting an analysis from a Spec Kit handoff now sends `plan.md`'s components and `tasks.md`'s
  task ids and titles as context for the code agent, apart from the requirements from `spec.md`.
  The context is never split into requirements or counted as one, has its own 4,096-character
  limit, and the analysis page lists what was sent as context and what did not fit.
- The analysis page shows the context text itself (collapsed, as plain text) on any run that has
  one, and a code finding can only be linked to a requirement of its run: a task id or component
  name written as a requirement id is cleared before the finding is saved.
