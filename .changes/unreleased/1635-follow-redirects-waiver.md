---
issue: 1635
section: Security
---

- The dependency audit carries a dated waiver for follow-redirects 1.16.1
  (GHSA-mrwp-f3q8-3g9p) until 3 November 2026, while the fix, 1.16.2, serves out the
  7-day release-age hold. The only copy comes through axios 1.20.0, which the advisory
  says is not affected, and no METIS code calls axios or follow-redirects directly.
