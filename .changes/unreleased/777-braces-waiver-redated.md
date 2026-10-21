---
issue: 777
section: Security
---

- `Dependency audit`: the braces GHSA-vfj7-8cjw-p6xm waiver is re-dated to 2027-01-15. No fixed
  braces exists, and no ESLint config here loads the Next plugin that is braces' only consumer.
- `Dependency audit`: vite moves to 8.3.4 for GHSA-587h-7wmj-h5pm (CVSS 7.5, published 2026-10-20),
  which had turned the gate red on `main`; found by reproducing the gate locally for this issue.
