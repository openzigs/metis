---
issue: 1246
section: Changed
---

- A Business Requirements document for one repository, or limited to paths, now
  lists only the approved requirements METIS has linked to that code (a code link
  or a merged pull request there). An approved requirement with no code link is
  left out of it, and the section says so; every approved requirement is still
  under Requirements and in a document for the whole project.
- Such a document goes out of date only when its own list changes: an approval
  or edit of a requirement it does not list no longer marks it stale, and a new
  code link that brings one into its list does.
