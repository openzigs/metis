---
issue: 791
section: Fixed
---

- Impact analysis no longer proposes a core `users` column for a request existing code already
  performs (for example "mark all as read older than X"). When a request is bounded by an age or a
  date and an existing function already filters by one, no column the model proposes is added to
  the migration, whatever the model answers: it is an optional settings column or not proposed.
- To get a column into the migration for such a request, write its `ALTER TABLE` in the request.
  Columns in any other request are proposed as before and marked **Proposed, not checked**.
