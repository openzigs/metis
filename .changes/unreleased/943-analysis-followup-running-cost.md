---
issue: 943
section: Fixed
---

- Regenerating an agent, or resuming skipped repositories, on a finished analysis now shows the
  analysis as running until its requirements have been rewritten. Before, it stayed "completed"
  while the model was still being called. The agent run page now counts every model call billed to
  the analysis, including those made after the run first finished (a regenerate, a clarification
  round, a deep dive). One analysis had shown $0.14 of its $0.46.
