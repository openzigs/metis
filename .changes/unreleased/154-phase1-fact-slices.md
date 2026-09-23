---
issue: 154
section: Changed
---

- Document generation sends each section only the topic slices of each module's
  facts it needs (rules, workflows, entities, …), so far more of a large codebase
  reaches every section at the same facts budget.
