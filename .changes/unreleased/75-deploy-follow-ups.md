---
issue: 75
section: Fixed
---

- Helm: new `persistence.uploads.enabled` / `persistence.lancedb.enabled`
  (default `true`). `values-prod.yaml` sets both `false`, so its two server
  replicas no longer share ReadWriteOnce PVCs; under `scaling.enforce` the chart
  now refuses any RWO server PVC when `server.replicaCount > 1`.
- `/readyz` fails (503) under `VECTOR_STORE=pgvector` when Postgres has no
  `vector` extension, instead of failing on the first ingest.
- The Helm backup CronJob now includes the server data directory (the SQLite
  database), not only uploads and LanceDB.
