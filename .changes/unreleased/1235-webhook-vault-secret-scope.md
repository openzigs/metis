---
issue: 1235
section: Security
---

- A scheduled webhook job can only send a vault secret its author created (admins excepted): naming anyone else's secret, or moving a job that holds one to a new URL or project, is refused and audited. Each run re-checks before reading the vault, so an older job that names a secret its author may not use sends nothing and fails with a clear error.
