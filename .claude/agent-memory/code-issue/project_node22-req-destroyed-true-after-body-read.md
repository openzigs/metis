---
name: node22-req-destroyed-true-after-body-read
description: On Node 22 req.destroyed is true on a live Express request once its body is read, so it cannot detect client disconnect (#2472).
metadata:
  type: project
---

**Why:** on Node 22, `req.destroyed` flips to true after the request body has been fully read, while the connection is still open. A disconnect check built on it aborts every request that has a body.

**How to apply:** detect a client disconnect with `res.closed` or `req.socket.destroyed`, and test with a real HTTP request that has a body, not a hand-built fake `req`.
