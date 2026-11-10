---
issue: 2197
section: Fixed
---

- Workspaces: signing out forgets your active workspace, so the next person to sign in on the same
  browser no longer opens an empty **Projects** list. **Projects**, the **New project** wizard, and
  the Usage, Teams and Notifications settings use only a workspace you belong to, and **Projects**
  re-lists when you switch workspace in the header. Opening a project in another workspace makes it
  your active workspace, as choosing it in the header does, and it stays active after you leave.
