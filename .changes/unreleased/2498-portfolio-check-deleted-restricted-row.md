---
issue: 2498
section: Security
---

- A portfolio check now remembers which requirements it read. If a requirement resting on a
  document you may not see is later removed from its change request (a withheld replacement, or
  re-running the synthesis), the check's criterion, summary and restated requirements drawn from
  it stay "Restricted" for you instead of reappearing. A check that read only requirements you can
  see shows its full result as before.
