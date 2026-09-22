---
name: green-api-job-does-not-run-server-image
description: A green `api` CI job says nothing about whether metis-server runs — CI builds the image but never starts it (#39)
metadata:
  type: project
---

A green `api` job says nothing about whether `metis-server` runs: CI builds the
image and checks its size, but never starts it (#39). On `main` the container
already fails to boot (`ERR_MODULE_NOT_FOUND jszip`), and nothing in CI noticed.

**Why:** Found in review of PR #38 (#34, slimming the server image). A prune
that deletes a module the runtime needs still builds, still passes the size
gate, and still goes green.

**How to apply:** For any Dockerfile prune change, build the base and head
images, diff the `node_modules/.pnpm` store listing between them, and import
every module under `server/dist` in both containers (~6 min on arm64). Compare
the failure sets rather than expecting zero failures, since #39 already breaks
some imports on `main`. This is the only runtime check until a `/healthz` smoke
test lands in CI.
