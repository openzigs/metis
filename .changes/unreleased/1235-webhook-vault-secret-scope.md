---
issue: 1235
section: Security
---

- A scheduled webhook job can only send a vault secret that whoever set its URL, project or secret may use (admins excepted): naming anyone else's secret, an ambiguous label, or moving a job that holds a foreign secret is refused and audited.
- Each run re-checks everyone recorded as setting the job's binding, including edits made before this fix, at their current role and account status. A job that fails the check sends nothing and fails with a clear error.
- Behaviour change: `${vault:<label>}` references in a webhook `authHeader` now resolve. They used to fail every run, so a dormant admin-authored job that names a label will start sending when this is deployed.
