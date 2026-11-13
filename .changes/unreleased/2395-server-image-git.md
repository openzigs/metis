---
issue: 2395
section: Fixed
---

- The `metis-server` image now ships `git`. Repository connectors clone through it, and the slim
  base image has none, so ingesting from a repository failed in the container while working in
  local development. The image smoke test now fails if `git` is missing or older than 2.36.
