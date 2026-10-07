---
issue: 767
section: Security
---

- GHSA-vfj7-8cjw-p6xm (braces 3.0.3, CVSS 8.7) now has a waiver that expires on 2026-11-01. No patched braces release exists, and braces is reached only through the UI's dev-time ESLint tooling. A test fails if any other dependency starts pulling it in.
