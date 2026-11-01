---
issue: 1635
section: Security
---

- The container image scan now carries the same dated waiver for follow-redirects
  1.16.1 (CVE-2026-116689, the Trivy alias of GHSA-mrwp-f3q8-3g9p) as the
  dependency audit, with the same expiry, package copy and reachability guard, so
  a pull request that rebuilds the server image is no longer red on it.
