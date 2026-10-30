---
issue: 1587
section: Fixed
---

- On the Analysis page, a user without the `project.update` permission (for example a developer)
  now sees the requirement card's assignee picker, the suggested acceptance criteria's Accept and
  Dismiss, "Keep approved criteria for all" and the "Diverged from source" choice disabled, with
  the hint "Requires project.update". Before, each was offered and the server refused it only after
  the user acted. Review and Compare stay available.
