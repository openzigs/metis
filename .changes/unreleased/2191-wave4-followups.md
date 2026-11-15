---
issue: 2191
section: Changed
---

- While a just-generated document is open on the Documentation page and its index is still being
  built, the page re-reads only that document, not the whole document list as well; going
  back to the list reads it afresh, and it keeps re-reading while an index is pending.
