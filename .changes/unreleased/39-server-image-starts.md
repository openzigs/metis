---
issue: 39
section: Fixed
---

- The `metis-server` image starts again. It exited at import time: `jszip` was
  declared as a development dependency, the image deleted `@prisma/debug` and
  `mysql2` though the server imports both, and the boot-time migration guard
  ran `pnpm`, which the image does not ship. The guard now runs the Prisma CLI
  with the server's own Node, and the image keeps that CLI.
- LanceDB and the Oracle connector's thick mode load in the image. The runtime
  base is now `node:22-trixie-slim` (glibc) instead of `node:20-alpine`, because
  LanceDB publishes no musl binding; the Oracle Instant Client is on the loader
  path. The image is larger as a result, and its size budget is re-measured.
- CI starts the `metis-server` image it builds, waits for `/healthz`, and loads
  LanceDB, `mysql2`, `better-sqlite3` and Oracle thick mode inside it. An image
  that does not start now fails the `api` job instead of passing it.
