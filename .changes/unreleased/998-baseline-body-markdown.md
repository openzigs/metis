---
issue: 998
section: Fixed
---

- The baseline detail page, the Gap report cards and the review page render requirement bodies as
  Markdown instead of printing raw `##`, `**` and `>` syntax, and no longer show METIS's internal
  `metis:` markers (the clarifications block and the criteria flag).
- Requirement bodies no longer load images, on these pages and on the Requirements tab: a Markdown
  image is shown as its alt text, linked to the address when it is a web URL. An image in imported
  issue text could otherwise report who opened the page.
