---
name: storage-probes-must-target-real-default-paths
description: A storage probe writing to a scratch path can pass while the server's real default path fails; probe through the server's own code
metadata:
  type: project
---

**Storage probes must target the server's real default paths.** A probe that
writes to a scratch path can pass while the real default fails.

Measured in #54 and #45. The #39 image smoke checked LanceDB with
`connect("/tmp/metis-smoke-lance")` and ran SQLite with
`DATABASE_URL=file:/tmp/metis-smoke.db`. Both passed. Meanwhile the server's own
defaults were broken:
- The default path was `<cwd>/data/lancedb` = `/app/data/lancedb`, and `/app` is
  root-owned, so uid 1001 got `EACCES`.
- With no `DATABASE_URL`, the migration guard migrated `/app/server/dev.db` (its
  cwd is the server root). The client opened `./dev.db` from cwd `/app` and got
  "unable to open database file".
- `/healthz` still answered 200.

The Helm chart mounted its PVCs at `/app/server/data/*`, a path the server never
wrote to.

**How to apply:** make a probe call the server's own resolver or factory, for
example `getVectorStore()` or `resolveDocumentStorage()`. Run it with the
server's cwd and environment (for `docker exec`, pass no `--workdir`). Read back
what it wrote through the same path. Give it no path, and do not set the env var
that the default replaces.
