---
issue: 1119
section: Fixed
---

- Generated documents: a cited module in a top-level directory named `canon` is shown as
  module facts in its footnote again. Since the topic plan landed it read "canonical fact",
  whatever `DOCS_GEN_TOPIC_PLAN` was set to.
- With `DOCS_GEN_TOPIC_PLAN=on`: a source file path can no longer close the canonical facts
  block, add a field to a fact line or put a line break in a footnote; the facts sheet is
  ordered the same on every machine; the consistency note quotes only statements that are
  in the final document; and every planned run logs what each section kept against the cut
  without a plan, at the section cap as well as the document cap.
- `docs/OPERATIONS.md` 6.5 now states the length guarantee exactly (the document as a
  whole, not each section) and why the variable is better left unset than set to `off`.
