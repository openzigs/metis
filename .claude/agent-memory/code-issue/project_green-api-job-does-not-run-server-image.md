---
name: green-api-job-does-not-run-server-image
description: RESOLVED by #39/#45 — the `api` job starts metis-server on SQLite and Postgres and polls /healthz; a size or build pass alone never meant it ran
metadata:
  type: project
---

**Resolved (#39).** The `api` job now runs `scripts/lib/smoke-server-image.mjs`
against the image it built: it starts the image with its own CMD, polls
`/healthz` until 200, then loads LanceDB, `mysql2`, `better-sqlite3` and Oracle
thick mode inside the running container, and checks the
runtime user can write its home (Debian `useradd --system` makes none). A green `api` job now means the server
image boots on SQLite.

**Why it mattered:** before #39, CI built and weighed the image and never
started it. `main` shipped a `metis-server` that exited at import time (a
runtime import declared as a devDependency, a pruned `@prisma/debug`, a
glibc-only LanceDB on a musl base, a migration guard that spawned `pnpm` in an
image with no package manager) while every gate was green.

**How to apply:** for a Dockerfile prune change, the smoke step is the check —
run it locally with `node scripts/lib/smoke-server-image.mjs --image <tag>`
against an amd64 build before pushing. A module that `/healthz` never loads is
invisible to it unless it is in `MODULE_PROBES`; add a probe when a new native
or lazily-imported dependency lands. Since #45 the smoke runs two arms: SQLite
with no `DATABASE_URL`, and Postgres (a `pgvector/pgvector:pg16` container on a
private network). `--database sqlite|postgres` runs one arm for a quick local check.
