---
issue: 2394
section: Fixed
---

- A reviewer who can no longer open a project (removed from its workspace, or
  the project deleted), or whose account is disabled, is no longer told about
  that project's reviews: the live refresh of the sidebar Reviews count, the
  "Review requested" and "Re-review requested" notifications, and the "requirement
  changed" notification all go only to people who can still open the review.
  The open review page's refresh, sent to everyone viewing the project, is unchanged.
