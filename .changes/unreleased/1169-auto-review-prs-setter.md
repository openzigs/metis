---
issue: 1169
section: Fixed
---

- Automatic PR review can now be switched on. Project settings has an
  **Automatic PR review** switch, and `PATCH /api/projects/:id` accepts
  `autoReviewPrs` (`project.update`, audit-logged). Before, nothing could set
  it, so no webhook review ever ran. The switch says each review spends model
  budget and is disabled, with the reason, until a GitHub repository is
  connected. `/projects/:id/pulls` says when review is off.
