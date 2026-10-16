---
issue: 1220
section: Fixed
---

- Import re-sync no longer puts back an analyst's edits to an imported requirement. An unchanged source keeps the edit; a changed source is applied only to an unedited requirement; when both changed, the card shows **Diverged from source** with **Take the source version** and **Keep mine**, and History records the choice. Run summaries count kept edits and divergences.
