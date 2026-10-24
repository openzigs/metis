---
issue: 1509
section: Fixed
---

- The Jira webhook receiver reads its delivery id from `X-Atlassian-Webhook-Identifier`, the header Atlassian documents. It read `X-Atlassian-Webhook-Id` and `X-Request-Id`, which no Jira variant is documented to send, so a Jira retry was not recognised as the same delivery.
