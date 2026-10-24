---
issue: 1504
section: Fixed
---

- The Triggers settings page suggested a GitHub event of `issues.opened`, which never fires:
  triggers match the bare event name (`issues`). The example now shows `issues`.
- Saving a GitHub trigger whose `event` contains a `.` is refused with a message naming the
  bare event, and the page now shows why a save failed. A trigger already stored that way is
  left unchanged and flagged with a warning on the Triggers page.
