---
name: job-id-reused-across-runs
description: Doc generation reuses docId as jobId across regenerations
metadata:
  type: project
---

PR #515 cached per-job section progress; a regeneration replayed the previous run's sections because the jobId was the same docId.

**Why:** In-process memory keyed by job id carries state between runs unless something clears it.

**How to apply:** Clear per-job memory on the run's `started` event, and test two runs on one id.
