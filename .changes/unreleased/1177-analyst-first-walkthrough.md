---
issue: 1177
section: Changed
---

- The end-to-end walkthrough is reshaped around the business analyst: journey 1
  now has a reviewer who rejects and then approves and a second analyst who
  comments, mentions and discusses, with operator-run or operator-approved
  second-user sign-ins. The BRD's Word and PDF exports are fetched by URL and
  opened, and a Jira publish step waits on the sandbox Jira.
- The developer side is a smoke test: a Spec Kit smoke set (S2, S4, S6, S7,
  S21), two developer requests in wave E, and wave G only when Spec Kit or
  impact analysis changed. The results template reports the analyst journey
  first and marks which run-to-run numbers stop being comparable.
