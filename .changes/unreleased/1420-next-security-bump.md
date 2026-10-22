---
issue: 1420
section: Security
---

- Next.js moves from 16.3.8 to 16.4.1, fixing an unauthenticated remote code
  execution in the image optimiser when SVG files are involved
  (GHSA-2464-fhr4-w9xw, critical) and a denial of service through Server Actions
  (GHSA-p3m5-59mp-jv5r, high). METIS does not allow SVG through the image
  optimiser and loads no remote images, but the dependency audit failed on every
  pull request until the version moved.
