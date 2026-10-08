---
issue: 909
section: Fixed
---

- Approving a re-run's requirements no longer mistakes them for the earlier
  run's (every run numbers from REQ-001), nor adds them beside the reviewed set.
- A requirement reopened and approved after promotion is no longer added twice
  when the promoted row's title was edited, and two concurrent metadata writes
  no longer erase the record of what was promoted.
- Promoted requirements keep their reviewed type as a label. The Approvals tab
  warns when the reviewed list differs from the synthesis set, and Deep Dive
  says "Checking approvals…" while approvals load instead of "0 pending".
