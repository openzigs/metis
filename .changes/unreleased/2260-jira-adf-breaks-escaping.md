---
issue: 2260
section: Fixed
---

- A requirement imported from Jira Cloud now keeps its line breaks (a Shift+Enter break in a Jira description was read as a space), keeps a list item's second paragraph as its own paragraph, and shows text such as `[1]`, `*`, `_`, `~` or `<b>` as typed: a `]` inside link text no longer ends the link, back-to-back bold runs no longer turn into stray asterisks, and text that looks like a Markdown link or HTML tag is never made into one.
- Only characters that would form Markdown are escaped, so an imported body reads as typed in the edit field (`snake_case_name`, `2 * 3`, `[1]`, `R&D`). Bold-italic followed by italic no longer leaves stray asterisks, and a line that starts with `- `, `# ` or `1. ` after a Shift+Enter break stays text.
- The Library's "not ingested" note after a Confluence or Jira run is now announced by screen readers.
