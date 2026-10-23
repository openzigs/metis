---
issue: 1438
section: Security
---

- Nothing runs in the background for a deleted project any more. Its webhook
  triggers answer 410 instead of firing, its scheduled jobs are skipped, work
  queued before the delete (background runs, scheduler tasks, imports,
  regenerations, PR auto-reviews) is cancelled, and a merged pull request no
  longer updates its requirements. No Teams card or PagerDuty page is sent for
  it, and its MCP servers are no longer health-checked or restarted. Triggers and schedules are left as they were,
  so a restored project resumes unchanged.
