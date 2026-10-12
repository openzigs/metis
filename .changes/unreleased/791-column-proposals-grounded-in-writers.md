---
issue: 791
section: Fixed
---

- Impact analysis no longer proposes a core `users` column for a request existing code already
  performs (for example "mark all as read older than X"). Each proposed column is checked against
  the functions that write the affected data — their parameters and the columns they filter on —
  so the result no longer depends on what the model named the column. A column that would only
  remember a preferred value is an optional settings column, outside the migration the change needs.
  The check reads what the request asks, not its background sections, and a column it had no
  existing function to compare with is still proposed and marked **Proposed, not checked**.
