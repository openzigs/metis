---
issue: 2593
section: Fixed
---

- The impact result page no longer contradicts itself. Its header leads with the requirements and
  files to edit, with the symbol count as **Reach** (code to review), and it shows the run's cost.
  The low-confidence warning and the export's **Match quality** come from one grade, with no more
  *"Confidence: 1.00"*. A project with no database connection reads *"Database impact not checked
  (no database connection)"*, never *"confined to code"*. A **Could not verify** finding no longer
  also shows *"INFERRED 90%"*.
