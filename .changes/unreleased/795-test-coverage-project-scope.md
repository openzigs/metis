---
issue: 795
section: Security
---

- Test-coverage endpoints now check that you can access the project in the URL before doing
  anything. Overriding a coverage mapping or accepting or rejecting a suggestion now only works on
  rows from that project's own runs. An id from another project now returns 404 and changes
  nothing; before this fix the change was applied.
- Test-coverage endpoints are now rate-limited: 900 requests per user and 3,600 per IP every 15
  minutes. Over the limit you get 429 `TEST_COVERAGE_RATE_LIMITED`. Change the limits with
  `TEST_COVERAGE_RATE_LIMIT_MAX`, `TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX` and
  `TEST_COVERAGE_RATE_LIMIT_WINDOW_MS`.
