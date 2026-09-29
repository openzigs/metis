---
issue: 405
section: Fixed
---

- Library → Agents, scoped to a project, offers **New agent** again (it opens the
  authoring wizard for the project's workspace) and a **Delete** on each custom
  agent the project owns, behind a confirm. Both were lost when Settings →
  Custom agents was retired; built-in agents still cannot be deleted, and the
  server still decides who may delete.
