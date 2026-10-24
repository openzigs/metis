---
issue: 1484
section: Security
---

- A captured signed GitHub or Jira webhook delivery can no longer be replayed under a new delivery id and timestamp: each receiver keeps the SHA-256 of the signed body for 7 days and answers `DUPLICATE_PAYLOAD`, and GitHub events whose signed `updated_at` is over 4 days old answer `STALE_DELIVERY`. The unsigned `X-Webhook-Timestamp` check is removed.
