---
issue: 1225
section: Fixed
---

- Removing every clarification answer from a requirement no longer strips the indentation of the
  line after the block (an indented code block stayed a code block) or a trailing hard break, and
  text typed on a marker's own line no longer becomes an indented code block.
- A Clarifications block whose markers, including the "check the acceptance criteria" flag, were
  retyped with different spacing no longer gets a new requirement version when its answers are
  unchanged, and editing the criteria clears a flag retyped that way.
- The clarification note no longer crashes on a "not applied" reason it does not recognise, and
  says how many answers were not written because their requirement changed or was deleted, and
  that submitting the answers again retries.
