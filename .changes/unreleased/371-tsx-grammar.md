---
issue: 371
section: Fixed
---

- The code graph now parses `.tsx` files with the TSX grammar. They were read
  with the plain TypeScript grammar, in which JSX is invalid, so top-level React
  components whose bodies held JSX (often every declaration after the first
  one) were missing from code search, chat code tools, impact analysis and Spec
  Kit grounding, while their nested handlers were still indexed. `.ts` parsing
  and symbol ids are unchanged, and `.jsx` was never affected. **Re-ingest a
  repository to pick up the missing symbols**; existing graphs are not rewritten.
