---
issue: 944
section: Fixed
---

- Spec Kit no longer saves a document the model's output-token limit cut off as if it were
  complete. It keeps the whole lines, asks the model to continue, and if the limit still wins it
  marks the document incomplete and the step says so. Specs and plans now also see the existing
  code and every place that already calls it, and a plan whose diagram links to an undeclared
  node is reported.
