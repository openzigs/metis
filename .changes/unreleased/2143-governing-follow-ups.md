---
issue: 2143
section: Fixed
---

- Governing questions and reasons: every handle after "Annex" or "Appendix" stays as written
  ("Annex A1 and A2"), and "A1 or A2" names each answer on its own, not "the analyst's answers".
- A clarifying question that names a requirement by its label ("the REQ-001 requirement") no
  longer gets the requirement's title added after it.
- Carried answers: the server's memory of carried judgings is one budget over all analyses.
- `eval:governing`: two `governing-01` pairs measure whether one part of a multi-part rule earns
  **Compliant** on the rest (a first run found it can, #2152), and a rule that could not be
  cited is its own stage.
