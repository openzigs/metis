---
issue: 1162
section: Fixed
---

- Writing clarification answers into a requirement and re-syncing an import now
  record a version, so a review pinned at an earlier version shows the text the
  reviewer was actually asked to approve. A concurrent analyst edit is kept
  rather than overwritten, and never fails the enrichment or the import run.
- A requirement's review status is no longer part of its version history: it is
  the verdict on a version, so approving or rejecting no longer counts as a
  change, and restoring an old version leaves the status alone. Manual status
  changes are recorded in the audit log, and the history CSV export drops its
  `reviewStatus` column.
