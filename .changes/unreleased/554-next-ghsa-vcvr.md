---
issue: 554
section: Security
---

- Next.js is updated to 16.3.6 for GHSA-vcvr-r3jv-pc5j, a critical remote
  code execution flaw in `next/og` image responses. METIS does not use
  `next/og`, so it was not exposed; the update clears the dependency audit.
