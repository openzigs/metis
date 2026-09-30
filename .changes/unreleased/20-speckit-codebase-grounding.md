---
issue: 20
section: Changed
---

- `/plan` always searches the code graph, must name the existing files it changes and justify any new component, and the reply lists backticked paths that match no indexed file (expected for new files) and warns when the plan names no existing file at all.
- `/specify` and `/plan` search on the requirement itself rather than the project name, and pin up to eight more chunks of each of the top two retrieved non-source documents (such as the requirements document).
- `/specify` must reconcile its scope lists with the retrieved requirements; `/tasks` must put tests before or with their implementation, and the reply names any test task that trails it.
- "Grounded on N chunks" now counts code symbols as well as document chunks.
