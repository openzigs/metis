---
issue: 102
section: Security
---

- Resolving a drift event now checks that you can reach the project the drift belongs to, not only
  that your role may resolve drift. Before, any holder of the resolve permission could resolve
  another project's drift by its id. A drift in a project you cannot reach answers "not found",
  exactly as an unknown drift id does.
