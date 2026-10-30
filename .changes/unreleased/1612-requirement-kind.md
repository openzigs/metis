---
issue: 1612
section: Added
---

- Requirements carry a **kind**, functional or non-functional, separate from
  their type, and a non-functional one names its category (performance,
  security, ...). The analysis sets it only when the evidence shows which it
  is, never by default. It can be set through the requirement PATCH API, and a
  kind an analyst set survives a re-run of the analysis.
