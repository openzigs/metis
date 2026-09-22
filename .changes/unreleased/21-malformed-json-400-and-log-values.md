---
issue: 21
section: Fixed
---

- A request whose body is not valid JSON now returns 400 with error code
  `INVALID_JSON` instead of 500, and the rejected body is not echoed back.
- Server log lines that printed literal `%d`/`%s` placeholders now carry the
  real values as structured fields.
