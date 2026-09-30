---
issue: 401
section: Changed
---

- The analysis run's two document queries (the project's document list and the
  cited-document-id check) now come from one helper, and a test fails if either
  query stops filtering on the project or on deleted documents. Behaviour is
  unchanged; the scoping was correct but nothing proved it.
