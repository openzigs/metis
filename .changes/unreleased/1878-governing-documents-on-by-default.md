---
issue: 1878
section: Changed
---

- Governing documents are now **on by default**: every analysis checks each
  requirement against the rules of your workspace's company policies. Set
  `GOVERNING_DOCS_ENABLED=0` (or `false`, `no`, `off`) to turn it off. The
  default changed after a held-out reading of the shipped code on
  `claude-sonnet-5-5` passed every bar fixed in advance (recall 0.94,
  precision 0.60, citation accuracy 1.00, no Compliant without evidence).
  The findings are not an audit opinion. See the user guide's new section,
  "Checking Requirements Against Your Company's Policies".
