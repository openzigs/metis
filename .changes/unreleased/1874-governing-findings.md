---
issue: 1874
section: Added
---

- An analysis now records a finding for each governing rule that applies to a
  requirement: Compliant, Gap or Needs BA input, citing the rule's control id
  and the exact clause of the policy revision it was checked against.
  Compliant only when the requirement or your answer says how the rule is met;
  an unverifiable quote is dropped and marked Needs BA input. You can accept
  or reject each finding with a note, recorded in the audit log. Still behind
  `GOVERNING_DOCS_ENABLED`, off by default.
