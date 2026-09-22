---
issue: 60
section: Fixed
---

- The Helm production values can start: with `VECTOR_STORE=pgvector` or
  `DISCUSSION_RATE_LIMIT_BACKEND=postgres` the server used to exit before listening.
- The Helm default values can start. The image's SQLite default moved to
  `/app/server/data/metis.db`, which the chart now mounts writable. **SQLite with no
  `DATABASE_URL`:** copy `/app/server/dev.db` there, or set `DATABASE_URL` to it.
- `docker-compose.prod.yml` uses LanceDB (not the dev JSON store) on a named volume.
- CI boots the image with pgvector, under the Helm defaults, and on Dependabot PRs;
  the Oracle Instant Client download is SHA-256 pinned (#51).
