---
issue: 1981
section: Fixed
---

- A requirement whose evidence cites several places in one file that more than one connected
  repository holds now keeps a code link for each place. Before, only the most confident one was
  kept and the other cited lines were lost.
- A code link saved before the previous fix, tied to one repository's copy of the code by
  guesswork, is corrected the next time the requirement's code links are seeded: it becomes a
  link to the file and lines, unverified. Before, the guess stayed beside the corrected link and
  a re-ingest could mark it fresh.
- Regenerating the code pass of a multi-repository analysis now updates which repositories the
  analysis records as skipped for budget. Before, an analysis that once skipped its primary
  repository kept saying so after a regenerate analysed it.
