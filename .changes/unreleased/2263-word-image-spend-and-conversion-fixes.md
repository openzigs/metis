---
issue: 2263
section: Fixed
---

- Describing the images in an uploaded Word document now counts as project spend: each
  description shows on the usage page and counts against the project's monthly token budget, and
  once that budget is spent the images are listed as "image not read: the project's monthly token
  budget is spent" instead of being sent. Images are described four at a time, and one that takes
  longer than 45 seconds is listed as not read, so a document full of wireframes no longer holds
  its upload for minutes.
- Word conversion fixes: a link in a footnote, endnote or reviewer comment now points where the
  author set it; a table row that starts or ends short of the full width keeps its cells under the
  right columns; rows inside a repeating-section content control are kept; and a paragraph that
  reads `# like a heading` stays a paragraph. A governing document's images now say they are not
  described for that kind of document, rather than that no vision-capable model is configured.
- A Word attachment synced from Jira keeps its headings, requirement numbers and tables, read by
  the same converter as an upload; it was flattened to raw text.
