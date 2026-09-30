---
issue: 439
section: Changed
---

- A chat reply that read the project through its code-search tools is now
  labelled as grounded ("Grounded in Payments · 1 code lookup"), live and
  after a reload. Before, a reply that found its answer through those tools
  still said no excerpts were retrieved.
- The source count on a grounded reply now counts each code symbol in the
  fused code block, not the whole block as one. It counts the excerpts
  supplied to the model, not a judgement of how relevant they were.
- A reply that failed or was stopped early no longer shows a grounding label
  under its error.
