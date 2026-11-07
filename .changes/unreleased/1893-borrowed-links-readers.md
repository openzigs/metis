---
issue: 1893
section: Changed
---

- A code link borrowed from a similar requirement is no longer treated as the requirement's own
  code: it is left out of an issue draft's "Related code" section, the requirements document and
  its code-links appendix, the analysis traceability matrix, and it no longer brings a
  requirement into a repository- or path-scoped reader BRD. It still shows, labelled as borrowed,
  in the requirement's own code links.
- Borrowing code links now reports the links skipped because they were themselves borrowed and
  any named link that was not found, refuses a requirement borrowing from itself, and copies each
  link once when two borrows run at the same time.
