---
issue: 423
section: Added
---

- Hybrid code search is now callable directly: `POST /api/projects/:id/code-search`
  with `{ query, limit? }` returns the project's ranked code symbols, using the
  same search the chat `search_code_symbols` tool uses.
