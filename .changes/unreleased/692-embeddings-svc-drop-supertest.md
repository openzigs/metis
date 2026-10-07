---
issue: 692
section: Removed
---

- The embeddings sidecar no longer depends on `supertest` (dev-only). Its HTTP
  tests drive the app in process and never open a loopback port, which removes
  the port-shadowing flake seen on macOS.
