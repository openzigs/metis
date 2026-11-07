---
issue: 1958
section: Fixed
---

- Governing documents: a policy's own control id written on its own line above a clause (a
  bold `**AC-02**` paragraph, a `4.3.1` line) is kept again instead of being replaced by a
  `METIS-NNN` id. An id on the clause above, a list item or a table row still is not taken.
- Retrying a governing rule extraction now counts against the upload rate limit
  (`UPLOAD_RATE_LIMIT_MAX` per `UPLOAD_RATE_LIMIT_WINDOW_MS`), since each retry can start a
  billed model call per section.
- The monthly chargeback report's total spend now includes spend billed to the workspace
  rather than a project (governing rule extraction), shown as a "Workspace (no project)" line
  and under "Unattributed" by user, matching the workspace usage totals.
