---
issue: 960
section: Security
---

- Every Spec Kit route now checks project access itself, not only the caller's role. Before, a
  caller outside the project's workspace was refused only by an upstream check that depends on the
  order routers are mounted; now each route returns 404 on its own and writes nothing.
