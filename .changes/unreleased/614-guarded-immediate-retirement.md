---
issue: 614
section: Security
---

- When someone other than its owner replaces a Jira credential, the previous
  credential is no longer deleted while the owner is in the middle of binding it somewhere else
  (an in-flight binding write). It is kept and retired by the hourly sweep once that write's
  window has closed and nothing references it. Previously the immediate retirement could delete a
  credential the owner's concurrent write was about to use.
