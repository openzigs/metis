---
issue: 1162
section: Fixed
---

- Clarification answers and import re-syncs now record a version, so a pinned
  review shows the text the reviewer approved. A concurrent edit fails neither.
  A Clarifications section edited out of shape is left as written, and the
  answers are reported as not applied.
- An import re-sync still reverts local edits, which stay in History. With the
  approval gate on, its content changes need a new review before publishing.
- Review status is not versioned: a manual approve no longer makes a pinned
  review stale. The history CSV export drops its `reviewStatus` column.
