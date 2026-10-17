---
issue: 1225
section: Fixed
---

- Removing every clarification answer from a requirement no longer strips the indentation of the
  line after the block (an indented code block stayed a code block) or a trailing hard break.
- A Clarifications block whose markers were retyped with different spacing no longer gets a new
  requirement version when its answers are unchanged.
- The clarification note no longer crashes on a "not applied" reason it does not recognise, and
  says how many answers were not written because their requirement changed or was deleted.
