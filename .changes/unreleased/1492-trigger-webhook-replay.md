---
issue: 1492
section: Security
---

- GitHub triggers (`/api/webhooks/github`) no longer re-fire on a captured delivery resent under a
  new delivery id or a relabelled `X-GitHub-Event` header. A body with a signed time fires each
  trigger once; any other body (`create`, `delete`, a release edit) fires once within 90 days.
  Each trigger's own secret is tracked separately, so two webhooks still each fire their triggers.
- **Behaviour change:** a trigger filtered on `push`, `pull_request`, a pull-request review event,
  `issues` or `issue_comment` now matches the event the signed body is, not the header. Other
  events (`release`, …) still match on the header. A run's `event` is `"unknown"` when the signed
  body contradicts the header.
- Triggers beyond `MAX_TRIGGER_FANOUT` are reported as `capped` and fire on GitHub's Redeliver.
