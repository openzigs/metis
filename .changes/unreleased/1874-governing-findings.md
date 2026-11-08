---
issue: 1874
section: Added
---

- An analysis now checks each requirement against every governing rule that
  applies to it, and records a finding for each: Compliant, Gap or Needs BA
  input. Each finding cites the rule's control id and the exact clause it was
  checked against, in the policy revision that was current at the time.
- A finding is Compliant only when the requirement, or your answer to one of
  METIS's questions, actually says how the rule is met. Silence is never
  Compliant.
- A clause quote METIS cannot find in the policy is dropped, and the finding
  is marked Needs BA input.
- You can accept or reject each finding with a note, and every decision is
  recorded in the audit log.
- Still behind the `GOVERNING_DOCS_ENABLED` setting, which is off by default.
