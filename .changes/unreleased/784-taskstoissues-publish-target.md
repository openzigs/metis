---
issue: 784
section: Fixed
---

- `/speckit.taskstoissues` no longer defaults to the analysed repository (an open-source
  project's upstream). With no `repo`, it uses `SpecKitConfig.tasksToIssuesRepo`, then the
  project's saved publish target, then `SPECKIT_TASKS_DEFAULT_REPO`, and otherwise refuses.
- A non-dry export is refused with `501 SPECKIT_ISSUE_EXPORT_UNAVAILABLE`. It used to create
  no issue yet record every task as exported to issue #0, which blocked any later export.
- A dry run now says "Would export N task(s) to …" instead of "Exported".
