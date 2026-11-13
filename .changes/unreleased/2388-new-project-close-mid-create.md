---
issue: 2388
section: Fixed
---

- Closing the **New project** dialog while **Create** is still running no longer leaves that
  project attached to the dialog. Before, opening the dialog again and closing it took you to the
  earlier project's Overview. The project is still created, and a message still says so.
- The wizard's Source step names the project tab where a repository or database is connected later
  using the tab bar's own name for it (**Knowledge**), so the text cannot name a tab that does not
  exist.
