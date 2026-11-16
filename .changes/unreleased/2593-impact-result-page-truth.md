---
issue: 2593
section: Fixed
---

- The impact result page no longer contradicts itself. Its header leads with the requirements and
  the files to edit (*"2 requirements · 7 files to edit · 1 project"*) instead of *"3305 impacted
  symbol(s)"*, which now follows as **Reach**, saying it is code to review; a change request's
  impact runs list the requirements they affected. The low-confidence warning and the markdown
  export's **Match quality** come from one grade, the export no longer prints a meaningless
  *"Confidence: 1.00"* under that warning, and a spread match no longer warns when the code agent's
  citations led the files to edit. A project with no database connection now reads *"Database impact
  not checked (no database connection)"* where a requirement lists no table, and its summaries can no
  longer say the impact is *"confined to code"*. The page shows what the run's model calls cost, from
  the Usage & cost ledger. A finding marked **Could not verify** no longer also shows the agent's
  own *"INFERRED 90%"*.
