---
issue: 858
section: Fixed
---

- The database-schema document's AI calls are now recorded in project usage under `docs-gen`, count
  towards the generation's cost ceiling, and stop when the generation is cancelled.
