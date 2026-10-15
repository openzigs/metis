---
issue: 1143
section: Fixed
---

- A completed analysis run in which any agent failed now shows **completed with errors** in the
  run header and the run list, naming the failed agents, instead of a clean "completed".
- One malformed citation no longer discards an agent's findings, and neither does
  `citations: null` or a lone citation object: each citation is checked on its own, repaired
  where it can be and otherwise dropped, and the finding keeps the rest.
- Dropped citations are no longer silent: the run shows **completed with warnings**, naming the
  agent and how many it lost, and the capability banner explains why. The run list and snapshot
  carry `failedAgents` and `droppedCitations`.
