---
issue: 804
section: Removed
---

- The bug scanner's API is removed: the `/api/projects/:id/rule-sets`, `…/repositories/:repoId/scans` and `…/scans/…` (list, detail, findings, triage, publish) endpoints now return 404.
- The `scanner.run-scan` scheduler task is unregistered; a leftover one is refused as `UNKNOWN_TASK_TYPE`. Scan, task, audit and `scan-*` token-usage rows are kept for FinOps history.
- Deep Dive and Impact Analysis publishes are audited as `publish.github|jira.created|reused` (target `finding` / `impact_analysis`, `metadata.source`), not `scanner.scanner.publish.*`. The stale-commit gate and its `ERR_STALE_COMMIT` (409) are gone.
- The JSON LLM helper logs as `json-llm-client`, not `scanner-llm-client`; its metering warning reads `Usage metering failed; continuing`. Update log filters that match the old names.
