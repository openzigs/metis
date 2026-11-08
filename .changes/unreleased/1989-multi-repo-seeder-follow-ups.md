---
issue: 1989
section: Fixed
---

- A code link tied to one repository's copy of the code by guesswork is now removed when the
  corrected link to the file and lines already stands beside it. Before, only a guess with no
  corrected link next to it was fixed, so this one stayed and a re-ingest could mark it fresh.
- Regenerating the code pass of a multi-repository analysis in single-shot mode no longer leaves
  repositories listed as skipped for budget. That pass covers the whole project, so the
  "Analyze remaining repositories" action no longer appears after it.
