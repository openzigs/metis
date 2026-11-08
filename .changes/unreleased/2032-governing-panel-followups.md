---
issue: 2032
section: Fixed
---

- Governing findings: on Postgres, Accept or Reject on a finding no longer takes a second
  database connection while its own transaction holds one, so several BAs deciding at once
  can no longer exhaust the pool and time out. In the Governing rules panel, the note box
  now shows another BA's newer note after a refetch unless you have typed in it, so your
  next Accept or Reject does not overwrite their note with an old copy. "Answer the
  clarifying question" links only to a question the Questions tab shows, and otherwise to
  the tab itself. `eval:governing`: payables, taxables, payee, unpaid, prepaid, repayment,
  payroll and taxpayer now count as sharing vocabulary with pay or tax, and a pass cell's ‡
  is set only by a broken by-construction claim.
