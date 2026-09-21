---
issue: 5
section: Added
---

- CodeQL code scanning for TypeScript/JavaScript and Python, with a weekly
  scheduled run so newly-described vulnerabilities surface in code that has
  not changed. It complements the existing Semgrep and OSV-Scanner rather
  than replacing either: CodeQL does dataflow and taint tracking, which
  pattern matching cannot, and does not cover dependency advisories, which
  OSV does.
- Corpora and test fixtures are excluded from analysis. They contain patterns
  a scanner should object to on purpose, and scanning them would bury real
  findings under noise that is working as intended.
