---
issue: 1756
section: Added
---

- Impact analysis has an opt-in AI check of the files to edit (`IMPACT_LLM_EDIT_VERIFY`, off by
  default). One model call per changed requirement looks at the code search's wider candidate list
  and may add a file to the files to edit, with a one-line reason and a line checked against the
  code, or mark a listed file as doubtful. It never removes or re-ranks a file the search chose; the
  run summary says what it added, doubted and dropped.
