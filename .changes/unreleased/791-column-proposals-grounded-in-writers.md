---
issue: 791
section: Fixed
---

- Impact analysis no longer proposes a core `users` column for a request existing code already
  performs (for example "mark all as read older than X"). When a request is bounded by an age or a
  date and an existing function already filters by one, no column the model proposes is added to
  the migration, whatever the model or the table-relevance filter answers: it is an optional
  settings column or not proposed.
- A column enters the migration of such a request only when the request itself asks for it: an
  `ALTER TABLE` statement, or a sentence such as "add a delay field to users". Columns in any other
  request are proposed as before and marked **Proposed, not checked**, except one the model itself
  labels a user preference, which is listed as optional.
