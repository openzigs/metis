---
issue: 39
section: Fixed
---

- The `metis-server` image starts again: it exited at import time on missing
  runtime modules, and its migration guard needed `pnpm`, which it lacks.
- LanceDB and Oracle thick mode load: the runtime base is now glibc
  (`node:22-trixie-slim`), since LanceDB has no musl build. The image is larger.
- CI starts the built server image and waits for `/healthz`, so an image that
  cannot start fails the `api` job.
