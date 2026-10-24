---
issue: 1478
section: Fixed
---

- A GitHub redirect off the request's origin (host, port or scheme) now fails
  with a clear, non-retryable error rather than a retried "server error"; a PR
  review is no longer re-run, model call and all, for it.
- A POST answered with a 301, 302 or 303 is followed as a GET without the old
  body's content type.
- PR-review spend is recorded at the larger of the configured and reported
  model's price, so the monthly limit cannot be undercounted.
- A monthly PR-review limit of 0 reads as "no limit" in the UI, as on the server.
