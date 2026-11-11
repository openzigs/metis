---
issue: 2244
section: Fixed
---

- Requirements imported from Jira Cloud no longer read as raw `{"type":"doc",...}` JSON. Their
  descriptions, and any rich-text custom field mapped to the body, are converted to Markdown:
  headings, bold and italic, links, nested and task lists, tables, code blocks, quotes, panels,
  mentions and dates. Links are kept only for web and email addresses.
- A Confluence or Jira ingest from the Library no longer cuts pages or issues silently. When a run
  hits its cap (200 pages, 500 issues) or the search returns fewer results than it matched, the
  Library says how many were left out and asks you to narrow the query. The ingest result line now
  shows the real new, updated, unchanged and failed counts. Before this fix the new and failed
  counts were blank.
