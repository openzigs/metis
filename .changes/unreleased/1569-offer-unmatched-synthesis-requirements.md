---
issue: 1569
section: Fixed
---

- Requirements that the analysis writes up and that match nothing on the reviewed list are no
  longer dropped. They now appear on the Approvals tab as requirements of their own, marked
  "Written up by the analysis", each with a pending approval, and approving one saves it with its
  acceptance criteria and evidence. Previously the tab could only warn that their criteria and
  evidence would not be carried over. The number added this way is recorded with each run and
  shown in the Approvals banner.
