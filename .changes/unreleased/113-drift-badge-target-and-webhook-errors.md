---
issue: 113
section: Fixed
---

- The pending-drift badge on the project Overview is now 24×24 pixels, the
  WCAG 2.2 minimum target size (it was 18×18). It also sits beside the Publish
  heading instead of inside it, so screen readers read the heading as
  "Publish" and not as "Publish View 3 pending drift events".
- When the GitHub issues webhook fails to sync spec-kit tasks, its response now
  says only `SYNC_ERROR`. The error text goes to the server log instead.
