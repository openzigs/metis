---
issue: 1616
section: Added
---

- A Spec Kit feature can be started from requirements you already approved:
  `POST /api/projects/:projectId/spec-kit/features/from-requirements` with
  `{ "requirementIds": [...] }` creates the feature and its `spec.md`. Only
  approved requirements of that project are accepted (404 for an id from
  another project, 422 naming any draft or rejected one), and every selected
  requirement reaches `spec.md` whole, in a **Source requirements** section,
  with no character limit cutting any of them.
