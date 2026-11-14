---
issue: 2302
section: Added
---

- Impact Analysis says how sure it is about each affected symbol and table, in the portfolio
  check's words: **Verified by graph path**, **Likely**, **Possible** or **Needs review**, on
  the page and on each line of the Markdown export (and so the Jira publish). A table's model
  judgment keeps its own badge, now reading **Likely related** for the likely tier. The
  thresholds were measured with the new `pnpm eval:impact-tiers` before they were fixed.
