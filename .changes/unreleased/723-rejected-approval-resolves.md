---
issue: 723
section: Fixed
---

- Rejecting a requirement in an analysis's Approvals checkpoint no longer dead-ends the run. A
  rejection now counts as a resolved approval: the rejected requirement is left out and the approved
  ones are promoted, so Requirements, traceability, the gap report, exports and **Deep Dive → Issue**
  work without a re-run. A rejected approval has a **Reopen** action that returns it to pending;
  approving it after the others were promoted adds that one requirement without replacing the rest.
  The Deep Dive button's tooltip now names the number of pending approvals holding it.
- A run already stranded with approved requirements but none promoted is promoted when you
  generate drafts, instead of reporting that every approval was rejected. Rejected evidence and
  clarification items are no longer described as "left out", since they exclude nothing.
