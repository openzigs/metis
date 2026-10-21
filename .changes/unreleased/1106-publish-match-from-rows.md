---
issue: 1106
section: Fixed
---

- A re-publish now finds an issue METIS published before from its own publish
  records, never from text on GitHub. The issue's hidden marker only confirms
  the match, so an edited or pasted marker can stop a match but cannot point a
  draft at another issue.
- The dry run marks each draft whose issue is checked at publish as "may match
  existing issue #N". Recovery no longer stops at 100 `metis-generated` issues.
- If GitHub cannot be read for such an issue, the draft is not created as a
  possible duplicate. It is marked failed and the batch says which issue could
  not be read.
