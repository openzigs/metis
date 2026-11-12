---
issue: 2222
section: Fixed
---

- Editing a requirement no longer leaves the analysis' results judging the old wording without a
  word. Governing findings that checked an earlier version are marked **Stale** ("checked at v0
  and is now v2") in the Governing rules panel, the BRD's governing section and the chat, and the
  analysis findings the requirement was written from are marked stale in the findings list and
  the traceability matrix (and its CSV and Markdown exports). A new **Re-check this requirement**
  button runs the governing check again on that one requirement's current wording and clears the
  marker on its results, without re-running the analysis.
