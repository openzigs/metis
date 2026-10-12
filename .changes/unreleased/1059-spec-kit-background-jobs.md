---
issue: 1059
section: Fixed
---

- Spec Kit: a command that calls the model now runs as a background job, so a `/speckit.plan` longer than five minutes no longer shows "Internal Server Error". The page shows the job's progress, picks it up again after a reload, and can cancel it.
- API: `POST …/spec-kit/commands/:cmd/jobs` answers `202` with a job id; `GET …/spec-kit/jobs/:jobId` reports its state, result or error. The existing route still waits and answers as before, but is refused with `409 SPEC_KIT_JOB_RUNNING` while another command holds the same feature.
- One command runs per feature at a time, and only that feature waits: the page disables Run there and says who is running what. Creating a feature (`/speckit.specify` with none selected) never waits.
- A job stopped by a server restart fails with `SPEC_KIT_JOB_INTERRUPTED` and is not run again. New setting `SPEC_KIT_JOB_TIMEOUT_MS` (default 30 minutes). Adds the `spec_kit_jobs` table (migration `20261019001059`).
