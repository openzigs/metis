---
issue: 554
section: Security
---

- Next.js is updated to 16.3.6 for GHSA-vcvr-r3jv-pc5j, a critical remote
  code execution flaw in `next/og` image responses. METIS does not use
  `next/og`, so it was not exposed; the update clears the dependency audit.
- axios is updated to 1.20.0 for five High advisories published the same day
  (HTTP/2 proxy bypass and denial of service, two ReDoS paths, and a
  prototype-pollution gadget in `toFormData`).
