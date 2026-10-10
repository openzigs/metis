---
issue: 744
section: Fixed
---

- Rejected requirements no longer become publishable drafts. Generating drafts
  skips them, and an unpublished draft made for a requirement before it was
  rejected is withdrawn; a published one is left alone.
- Publishing no longer turns internal database ids into labels in the target
  repository. The hidden `finding:<id>` traceability labels are kept out of
  drafts and stripped at publish time (GitHub and Jira), and a run creates only
  the labels some draft actually carries, not all nine base labels.
- The dry-run plan and the publish confirmation now show the approval gate.
  With "Require approved review" on, they warn that a live publish would be
  refused and tag each draft that still needs an approved review.
