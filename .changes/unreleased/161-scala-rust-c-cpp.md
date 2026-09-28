---
issue: 161
section: Added
---

- Scala, Rust, C and C++ support: `.scala`, `.rs`, `.c`, `.cpp`/`.cc`/`.cxx`
  and `.h`/`.hpp` files are parsed into the code graph during ingest, and each
  language gets a deterministic rule inventory in business-requirements
  generation (preconditions, guard clauses, failure modes, `match`/`switch`
  dispatch, validation attributes, constants) plus constant and calculation
  formulas. Uploaded archives now keep C and C++ source files.
