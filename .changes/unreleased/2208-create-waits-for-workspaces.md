---
issue: 2208
section: Fixed
---

- Projects: **Create** in the **Projects** dialog and the **New project** wizard waits until your
  workspaces have loaded, so a project is no longer created outside any workspace without a word.
  If your workspaces cannot be loaded, the form says so and offers **Try again**. Signing out now
  clears everything the app had cached for you, including your active project, and an expired
  session no longer leaves your workspace list behind for the next person to sign in.
