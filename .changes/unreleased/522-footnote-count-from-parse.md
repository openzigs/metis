---
issue: 522
section: Fixed
---

- In the document viewer, footnote numbers and back-links now match a
  whole-document render in every case. An escaped `\[^1]`, or a `[^1]` inside
  raw HTML or an indented code block, no longer shifts the numbering. A
  footnote cited on the line after an incomplete `[label]:` is no longer
  missed, and that `[label]:` line now shows as the text it is instead of
  being treated as a link definition.
