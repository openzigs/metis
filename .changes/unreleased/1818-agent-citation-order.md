---
issue: 1818
section: Fixed
---

- With `IMPACT_AGENT_SEEDS` on, the code agent's cited files now lead the files to edit in a
  fixed order, the surer citation first, so the same requirement gives the same list on every
  run. At most five further cited files are added as files to edit; any beyond that are listed
  under Related instead. A file promoted to the files to edit (by the citations, the AI edit
  check or the AI ranking) is no longer also listed under Related.
- "Evaluate new requirements" now records the code agent's citation of a file even when someone
  already linked that file to the requirement by hand, so the citation is not lost.
