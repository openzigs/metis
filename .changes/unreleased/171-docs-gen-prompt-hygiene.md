---
issue: 171
section: Fixed
---

- Docs generation sends each module's facts to a section once, and the faithfulness judge
  sees only the evidence its claims cite (with a bounded retrieval for uncited claims), so its
  prompt no longer grows with the facts cap. Claim extraction splits a cut-off passage at most
  once, splits large or unclosed code blocks, and keeps claims from passages that parsed. A
  Phase 1 chunk whose reply is stuck in a repetition loop is split once (so no file it never
  reached is dropped) and the text before the loop is cached instead of re-extracted every run;
  a numbered listing cut off at the output cap is no longer mistaken for a loop. A
  claim naming a mined rule's file:line is checked against that source line.
