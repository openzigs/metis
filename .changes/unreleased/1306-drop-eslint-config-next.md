---
issue: 1306
section: Security
---

- The UI no longer declares `eslint-config-next`, which no ESLint config loaded. Its plugin was
  braces' only route into the tree, so braces (GHSA-vfj7-8cjw-p6xm, no fixed release) is gone and
  the `Dependency audit` waiver for it is deleted rather than re-dated.
