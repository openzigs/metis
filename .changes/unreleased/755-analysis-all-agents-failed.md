---
issue: 755
section: Fixed
---

- An analysis run in which every selected agent failed is now marked failed, with the first
  agent error shown, instead of completed with no findings. Before, this only worked when both
  the document and code agents were selected, so a run with only the web agent (or any other
  set of agents) that failed entirely showed as a success.
