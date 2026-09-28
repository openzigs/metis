---
issue: 330
section: Fixed
---

- After the zod 4 upgrade, leaving out a required choice field returned "is
  invalid" instead of "is required", and review due dates, SLA deadlines, ACP
  token expiries and import manifest timestamps without seconds (or with a
  `+0100` offset on manifests) were rejected with a 400. Both behave as they did
  on zod 3 again.
