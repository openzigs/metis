---
issue: 2175
section: Security
---

- The notice sent when a Microsoft Teams account is linked to a workspace member now shows
  right-to-left overrides, zero-width spaces and other invisible characters in the account
  id and workspace name as visible `\uXXXX` codes, so the admin who made the link cannot
  use them to reverse or hide part of what the notice says.
