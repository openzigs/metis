---
issue: 2263
section: Fixed
---

- Describing a Word document's images now counts as project usage and against the monthly token
  budget; once the budget is spent the images are listed as not read. Images are described four at
  a time, and one taking over 45 seconds is listed as not read. Links in footnotes and comments,
  table rows that start short or sit in a repeating section, and a paragraph reading `# like a
  heading` now convert correctly, and a Word attachment synced from Jira keeps its numbering.
