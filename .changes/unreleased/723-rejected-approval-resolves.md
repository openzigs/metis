---
issue: 723
section: Fixed
---

- Rejecting a requirement in an analysis's Approvals checkpoint no longer dead-ends the run. A
  rejection counts as resolved: the rejected requirement is left out and the approved ones are
  promoted, with no re-run. A rejected approval has a **Reopen** action; approving it later adds
  that one requirement. The Deep Dive tooltip names the pending approvals holding it.
- A run stranded with approved requirements but none promoted can be recovered from the Analysis
  page with **Promote approved requirements**, or by generating drafts; the Approvals banner no
  longer claims promotion is unblocked when nothing was promoted, and generating drafts mid-run no
  longer promotes early. Rejected evidence and clarification items are not described as "left out".
- Promotion is refused only while a run is pending or running, not for a failed or cancelled one,
  and rejected approvals are no longer listed as outstanding anywhere.
