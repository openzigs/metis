---
issue: 1539
section: Security
---

- Every `/api` route and the `/metrics` scrape now sit behind one app-wide request budget,
  600 requests a minute per signed-in user by default (`API_RATE_LIMIT_MAX`,
  `API_RATE_LIMIT_WINDOW_MS`). About 300 routes had no limit at all, including repository
  ingest, evaluations and the unauthenticated SCIM, Slack OAuth callback and `/metrics`
  token checks, which could be guessed at without bound. Requests through the UI count
  per user, not per UI server, so one busy user cannot spend the organisation's budget.
  A caller past it gets `429 API_RATE_LIMITED`; the existing per-route limits still apply
  inside it.
