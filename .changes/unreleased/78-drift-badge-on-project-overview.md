---
issue: 78
section: Fixed
---

- The pending-drift count now appears on the project Overview's Publish stage
  and opens that project's sync dashboard when clicked. The badge existed but
  was rendered nowhere, so drift was invisible unless an operator already knew
  to open the sync page. The count updates live from a new `drift:detected`
  broadcast; the reconciler had accepted an emit dependency that no caller ever
  supplied, so drift rows were written and no client was told.
