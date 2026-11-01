---
issue: 1624
section: Added
---

- A portfolio assessment now comes with a business-analyst report. A plain-language
  summary opens with the verdict and what must change. Each affected product gets a
  paragraph on its functional, business and stakeholder impact. The requirement is
  restated as functional and non-functional requirements. A technical deep dive per
  affected product lists repos, files, contract items, tables, topics, the dependency
  path and how its severity was worked out. The Markdown export includes all of it.
  The written summary can only name products the assessment found; any sentence
  naming something else is dropped. When no model is available, a plain template
  stands in and the report says it is degraded.
