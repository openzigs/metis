---
issue: 564
section: Fixed
---

- In the document viewer, a long document now renders exactly as it would
  in one piece in two more unusual cases. A line holding only a non-breaking
  space is no longer treated as blank, so a link title or footnote that runs
  across it keeps all its text. A document that spells the viewer's internal
  section marker with a very long run of dashes no longer shows that marker
  as visible text.
