---
issue: 1571
section: Fixed
---

- PDF and Word exports of generated documents no longer print citation markers (`[^src-n]`) or
  formulas raw. Citations print as numbered superscripts that point to a Sources list at the end of
  the document. In the PDF, inline formulas are typeset like display formulas. In Word, formulas
  print as readable text (for example `interval = (7 × 24 h) / (weeklyCount × factor)`) instead of
  LaTeX, with display formulas centred on their own line.
