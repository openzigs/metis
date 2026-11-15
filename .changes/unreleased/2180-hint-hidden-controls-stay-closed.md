---
issue: 2180
section: Fixed
---

- On a requirement card, the add-link dialog, the add-mapping form (with what you had typed), the
  suggested mappings and the assignee search no longer reopen by themselves when a permission you
  lost is given back. Losing the permission closes them for good, and the assignee search stops
  looking up users while it is hidden.
- The User Guide now names the permission each requirement-card action needs: `connector.write`
  for data mappings, `project.update` for requirement links and the duplicate-warning answers.
