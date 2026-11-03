---
issue: 1648
section: Fixed
---

- Elicited non-functional requirements are no longer dropped as duplicates by
  mistake. A target such as `200ms` no longer matches `1200ms`, `1.5s` no longer
  reads as `15s`, and two requirements with the same target for different
  subjects (99.9% for the API and 99.9% for the database) are both kept. Targets
  are compared only within the same NFR category, and every one not added is
  logged.
- Applying a withheld re-synthesis no longer deletes the draft elicited
  non-functional requirements the analyst could already see. The comparison
  says they are kept.
- An elicited non-functional requirement is never reported as implemented (or as
  a confirmed gap) on the strength of a code finding it was drawn from: its
  verdict is at most "could not verify". One analysis run adds at most 20 of
  them.
