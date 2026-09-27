---
issue: 171
section: Fixed
---

- Docs generation sends each module's facts to a section once, and the faithfulness judge
  sees only the evidence its claims cite (with a bounded retrieval for uncited claims), so its
  prompt no longer grows with the facts cap. Claim extraction splits a cut-off passage at most
  once, splits large or unclosed code blocks, and keeps claims from passages that parsed. A
  Phase 1 reply stuck in a repetition loop is cached instead of re-extracted every run, and a
  claim naming a mined rule's file:line is checked against that source line.
