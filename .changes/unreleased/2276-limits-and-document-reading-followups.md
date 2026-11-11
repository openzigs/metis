---
issue: 2276
section: Fixed
---

- Regenerating an agent updates the run's "findings not saved" notice, and a
  recovered code answer over 50 findings names the ones it left out.
- The Analysis limits panel skips a malformed stored entry instead of failing.
- Impact analysis reads a document only when a project will be searched, bills
  it to that project and shows "Reading the document"; a run that never reads
  no longer lists "document reading" as not run. A read change is typed from
  the document's words, not the model's restatement.
