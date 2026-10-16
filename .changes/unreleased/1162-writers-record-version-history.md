---
issue: 1162
section: Fixed
---

- Clarification answers and import re-syncs now record a version, so a pinned
  review shows the text the reviewer approved. A concurrent edit fails neither.
- An import re-sync still reverts local edits with the source text, but the
  edit stays in History and can be restored. A content change from an import
  makes an approved review stale, so publish or export needs a new review.
- Review status is no longer versioned: a manual approve no longer makes a
  pinned review stale, and status changes go to the audit log. The history CSV
  export no longer has a `reviewStatus` column.
