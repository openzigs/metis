---
issue: 1169
section: Fixed
---

- Automatic PR review can now be switched on. Project settings has an
  **Automatic PR review** switch, and `PATCH /api/projects/:id` accepts
  `autoReviewPrs` (`project.update`, audit-logged). Before, nothing could set
  it, so no webhook review ever ran. The switch is disabled, with the reason,
  until a GitHub repository is connected. `/projects/:id/pulls` says when
  review is off.
- The same card sets a **monthly limit for automatic PR reviews** (USD;
  `prReviewMonthlyBudgetCents`) and shows this month's spend. Without a limit
  there is no cap on that spend. Once the limit is reached, new pull requests
  are not reviewed, and the card and `/pulls` say so.
