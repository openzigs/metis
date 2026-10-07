---
issue: 729
section: Fixed
---

- The workspace slug field on Settings → Workspaces validates again. Its
  `pattern` was not a valid regular expression under the `v` flag browsers
  use, so the page logged a console error and the browser ignored the check.
