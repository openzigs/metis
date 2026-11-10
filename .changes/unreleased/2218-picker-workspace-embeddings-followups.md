---
issue: 2218
section: Fixed
---

- A discussion's requirement search ignores letter case beyond plain ASCII on SQLite too, so
  "über" finds "Über …", and a `*`, `?` or `[` in the search box matches only itself.
- Pressing an arrow key in the requirement search just before new suggestions arrive no longer
  leaves Enter on a requirement you never moved to, and screen readers announce the first count
  of suggestions.
- Creating a project stays possible when a background re-read of your workspaces fails after they
  were read once, and "Try again" shows that it is retrying.
- The embeddings settings page no longer drops a running reindex after one coverage read that
  reached another server before the job had started there; it waits for a second.
