---
issue: 528
section: Fixed
---

- Publishing to GitHub now always updates the same existing issue when more than one earlier
  publish of a title left two issues behind. It prefers the issue of the draft being
  published, then the most recently published one, so a publish can no longer overwrite the
  other issue's body depending on database row order. The dry run and the pre-publish preview
  name the same issue.
