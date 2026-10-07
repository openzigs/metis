---
issue: 815
section: Changed
---

- The workspace traceability summary now reports, per project, how many
  requirements have mapped code (`codeMappedRequirements`) and what fraction of
  them have a linked test (`testCoverage`), or a test that is the mapped code or
  calls it (`strictTestCoverage`). Requirements with no mapped code do not
  lower these figures.
- The analysis traceability matrix's tests column (and its CSV and Markdown
  exports) now comes from the same "Tested by" resolver as the requirement
  chain and the test-gap list, so the three always agree. Each test also says
  how it was linked (`relation`). Tests are now found from a requirement's
  mapped code rather than from symbols cited in analysis findings.
