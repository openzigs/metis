---
issue: 184
section: Changed
---

- Documentation generation reads every function and all module-level code, in
  as many fact-extraction calls as a module needs; a cut-off call is split, not
  retried larger. Rule miners run uncapped over all code and every `.sql` file,
  every SQL-only directory is mined (a scan that cannot finish raises a warning),
  and the Business Rules section receives every mined rule, cited file:line.
- `DOCS_GEN_PHASE1_INCLUDE_TESTS` (default on) can leave test files out.
- Progress advances per extraction chunk and per section batch.
