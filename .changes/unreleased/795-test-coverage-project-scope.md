---
issue: 795
section: Security
---

- Test-coverage endpoints now check that you can access the project in the URL before doing
  anything. Overriding a coverage mapping or accepting or rejecting a suggestion now only works on
  rows from that project's own runs. An id from another project now returns 404 and changes
  nothing; before this fix the change was applied.
