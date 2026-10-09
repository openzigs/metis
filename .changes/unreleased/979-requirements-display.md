---
issue: 979
section: Fixed
---

- Requirement bodies render as Markdown, without the internal clarification
  markers; raw HTML in a body is never rendered as markup.
- Finding citations show a real arrow instead of a literal `→`.
- The clarification note no longer says answers "could not be matched" while
  requirements await approval, and lists which answers were applied where.
- The GitHub import types items from their labels or a leading `[Bug]:`-style
  title tag, and removes the tag from the title.
