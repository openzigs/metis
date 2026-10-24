---
issue: 1492
section: Security
---

- GitHub triggers (`/api/webhooks/github`) fire at most once per signed body. A captured
  delivery resent under a new delivery id, or with a relabelled `X-GitHub-Event` header, fires
  nothing. Each trigger's own secret is tracked separately, so two webhooks still each fire
  their triggers once.
- **Behaviour change:** a trigger filtered on `push`, `pull_request`, a pull-request review event,
  `issues` or `issue_comment` now matches the event the signed body is, not the header. A
  delivery whose body isn't that event no longer fires it. Other events (`release`, …) still
  match on the header.
