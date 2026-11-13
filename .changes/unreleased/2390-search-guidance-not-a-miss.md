---
issue: 2390
section: Fixed
---

- With chat search guidance on (`CHAT_SEARCH_GUIDANCE`), some code-graph results were wrongly
  followed by "nothing was found; search again": a name matching several symbols, probable call
  sites, or a symbol that nothing calls. Each now gets its own instruction about what to do next.
  Re-measured after the fix, the guidance still did not make answers more complete or citations
  more precise, so it stays off by default.
