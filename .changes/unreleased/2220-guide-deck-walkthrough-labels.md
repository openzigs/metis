---
issue: 2220
section: Fixed
---

- Review diffs, baseline compares and History name each field and show criteria and label changes
  as the items removed and added, never raw JSON or hidden ids. History can compare a single edit
  with the version before it, and its diff no longer clips.
- Notifications name their type in words and show a date; discussion rows say how the AI replies;
  `@mentions` and backticked names render as such. Similar requirements drop UUID keys, METIS-numbered
  governing rules say so, and the governing upload says what it still needs.
- "Review N requirements" opens the Requirements tab; requirement card actions and matrix paths
  wrap instead of squeezing or clipping.
