---
issue: 2107
section: Security
---

- Linking a Microsoft Teams account that was already linked to another workspace member
  moves it, and that member is now told: their notifications say the Teams account no
  longer acts as them, and who it acts as now. The audit entry records the member the link
  was taken from. The notice also shows the Teams account id and the workspace name in
  quotes, with at most 40 characters of the id, so the admin who made the link cannot
  change what the notice appears to say.
