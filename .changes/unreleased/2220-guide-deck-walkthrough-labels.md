---
issue: 2220
section: Fixed
---

- Review diffs, baseline compares and requirement History name each field ("Acceptance criteria",
  not `acceptanceCriteria`) and show a criteria or labels change as the items removed and added,
  never as raw JSON or hidden `finding:` ids. After a single edit, History offers the version
  before it, so the edit can be compared. The History diff fits its card instead of clipping.
- Notifications name their type in words ("Review approved") and show the date with the time.
  Discussion rows say how the AI replies instead of "AI: on_mention". `@mentions` in comments and
  discussion messages show as mentions. Backticked identifiers in acceptance criteria show as code.
- Similar requirements are no longer listed under a UUID. Governing rules METIS numbered
  (`METIS-002`) say so. The governing upload form marks its required fields and says what Upload
  still needs.
- "Review N requirements" opens the run's Requirements tab, not its Summary. The "Requirements
  you supplied" summary counts a requirement merged into another as analyzed.
- Requirement card actions wrap below the title instead of squeezing it, the change request list
  no longer stretches down the page, and long file paths in the traceability matrix wrap so the
  Tests column stays visible.
