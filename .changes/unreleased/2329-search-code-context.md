---
issue: 2329
section: Added
---

- A new chat code tool, `search_code_context`, returns whole functions and classes for a question
  in one call: matches next to each other in a file come back as one span, with numbered lines and
  the commit they were read at, and a long symbol comes back as its signature plus the part that
  matched. It is off by default (`CHAT_CODE_CONTEXT_TOOL`) until it is measured against the BA
  question set; the gap that merges two matches (`CHAT_CODE_CONTEXT_MERGE_GAP`) and the result's
  token budget (`CHAT_CODE_CONTEXT_TOKEN_BUDGET`) are configurable.
