---
issue: 121
section: Security
---

- `/api/health/deep` and `/readyz` no longer return exception text; failing checks
  answer a fixed message and the raw error is logged. Jira token and CA-cert
  rotation update the secret in place instead of failing on the vault's unique
  name (#106). Every `AI_*` millisecond setting uses one strict parser capped at
  2147453647, so no value can become a 1 ms timer (#123). Webhook receivers are
  counted once by their shared rate limiter (#105). Boot-time secret loading can
  no longer overwrite a newer saved secret (#122).
