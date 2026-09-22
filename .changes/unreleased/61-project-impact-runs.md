---
issue: 61
section: Fixed
---

- A project's **Analyze → Impact Analysis** page now lists the impact analyses
  that include that project. `GET /api/impact-analyses` accepts `?projectId=`,
  and each summary row carries `projectIds` — only the run's projects you can
  access; `projectCount` is unchanged.
