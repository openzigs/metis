---
issue: 1825
section: Fixed
---

- A drafted issue's Related code section and a requirement's traceability chain no longer list
  the same code twice when both the automatic requirement-to-code mapping and the code agent
  linked it. Each file and symbol is listed once, with the surer link. The drafted issue's
  "and N more" count leaves out repeats among the links it read; for a requirement with more
  than 50 links, a repeat among the rest can still be counted.
