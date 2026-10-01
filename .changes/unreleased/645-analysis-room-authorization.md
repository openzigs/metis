---
issue: 645
section: Security
---

- Subscribing to an analysis's live events (`subscribe:analysis`) now requires access to the
  analysis's project, the same rule as opening the analysis. A user outside the project, or one
  naming an unknown or deleted analysis, receives `auth:error` (`FORBIDDEN: no access to analysis`)
  and no events — previously any signed-in user could follow any analysis by id.
- A `subscribe:analysis` or `unsubscribe:analysis` emit with a null or missing payload no longer
  crashes the API process.
