---
issue: 67
section: Fixed
---

- A degraded generated document's section warnings no longer carry raw
  exception text. A section whose generation throws now produces a warning
  drawn from the fixed failure vocabulary, so no provider response body,
  server path or SQL fragment reaches the `warnings` column, the
  `GET /projects/:projectId/docs/:docId` payload or the UI banner. A provider
  402 stays recognisable as a balance problem, and warnings persisted before
  this change are sanitised on read.
