---
issue: 75
section: Fixed
---

- Helm: new `persistence.uploads.enabled` / `persistence.lancedb.enabled`; `values-prod.yaml`
  sets both `false`, so its server replicas no longer share ReadWriteOnce PVCs. Under
  `scaling.enforce` the chart refuses any RWO server PVC whenever more than one server pod
  can run, counting an enabled server HPA's `maxReplicas`, not only `server.replicaCount`.
- `/readyz` fails (503) under `VECTOR_STORE=pgvector` when Postgres has no `vector`
  extension, and is degraded when it is not created and the role is not a superuser.
- The Helm backup CronJob now includes the server data directory (the SQLite
  database), not only uploads and LanceDB.
