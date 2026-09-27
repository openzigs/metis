---
issue: 160
section: Added
---

- COBOL support: `.cbl`/`.cob`/`.cobol` programs and `.cpy` copybooks (fixed
  or free format) are parsed into the code graph — programs, paragraphs,
  data items, `PERFORM`/`CALL` edges and `COPY` bound to the copybook — and
  kept from uploaded archives. Business-requirements generation mines their
  rules: level-88 condition names, `IF`/`EVALUATE` conditions (including
  multi-line ones), validations and `COMPUTE` formulas.
