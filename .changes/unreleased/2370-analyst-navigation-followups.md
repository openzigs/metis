---
issue: 2370
section: Fixed
---

- The Reviews count in the sidebar counts only the reviews still waiting on your own decision. A
  review you have decided leaves it even while other reviewers have not, so it matches Home's
  "Reviews assigned to me". It updates when a review you are a reviewer of is decided, withdrawn
  or closed by someone else, whichever page you are on, instead of up to a minute later; and it
  shows no number, rather than an old one, when it cannot be re-read.
- A run's page no longer links a user who is not a system admin to the Runs list they cannot
  open: the "All runs" link is gone for them, and the breadcrumb names Runs without a link.
