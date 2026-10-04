---
issue: 785
section: Fixed
---

- Spec Kit plans see the existing functions beside each retrieved symbol (a
  "Sibling Symbols" list, e.g. `MarkAllAsReadBeforeDate` next to `MarkAllAsRead`)
  and must state an "Existing capability" before proposing a new function.
- Spec Kit retrieved context names repository files by their repo path and shows
  the rank score, not `connector:repo:…:src/…` with a 0.000 cosine.
