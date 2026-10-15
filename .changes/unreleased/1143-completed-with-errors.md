---
issue: 1143
section: Fixed
---

- A completed analysis run in which any agent failed now shows **completed with errors** in the
  run header and the run list, naming the failed agents, instead of a clean "completed". The run
  list and the analysis snapshot carry the failed agents as `failedAgents`.
- One malformed citation no longer discards an agent's findings. Each citation a model writes is
  checked on its own: one with a `null` optional field is repaired, one that is still invalid is
  dropped, and the finding keeps the rest.
