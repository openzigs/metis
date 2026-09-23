---
issue: 70
section: Fixed
---

- An impact analysis appears on its project's Impact Analysis page from the
  moment it starts, not only once it has written its first item. The projects a
  run was started for are now persisted with the run, so one that is pending,
  running, failed early, or found no changes still names them. This also closes
  an access gap: a run whose projects could not be determined was listed for
  every non-admin, showing members other users' in-progress runs on projects
  they cannot access.
