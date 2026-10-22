---
issue: 1422
section: Fixed
---

- Linear-time tests no longer fail when the full test fan-out loads the machine: `balanced-json` proves linearity by counting its work, and the regex-backed checks in `analysis/` and `docs-gen/` time only the CPU their own thread spends.
