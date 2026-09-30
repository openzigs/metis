---
issue: 510
section: Fixed
---

- Documentation generation progress now catches up after a connection drop. A
  section that finished while the live connection was down (for example across
  a session-token refresh) now appears on the Documentation page as soon as the
  connection returns, instead of only on the page's next refresh.
