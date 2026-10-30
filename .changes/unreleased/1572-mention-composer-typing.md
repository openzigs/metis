---
issue: 1572
section: Fixed
---

- Typing after you pick an @mention in a discussion (or a comment) keeps your text in the order
  you typed it. The cursor could jump back to just after the mention, scrambling the rest of
  the message, and the page could stop with a "Maximum update depth exceeded" error.
- The arrow keys move the highlight in the @mention list again. Before, ArrowDown was undone
  as soon as it moved, so Enter always picked the first name.
