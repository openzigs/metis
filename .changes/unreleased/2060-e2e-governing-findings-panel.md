---
issue: 2060
section: Added
---

- End-to-end coverage for the analysis view's Governing rules panel: a seeded workspace governing
  document with extracted rules, and an analysis with Compliant, Gap and Needs BA input findings
  (no live model). The spec checks each status's control id and quoted clause, that Accept and
  Reject with a note survive a reload with the decider named, and that an uncertain rule's
  "Answer the clarifying question" link lands on its question.
