---
issue: 1174
section: Fixed
---

- A document section whose cloud-provider stream drops part-way through the reply
  (`anthropic stream failed: terminated`) is now retried with backoff, up to three
  tries, on every provider instead of only the local runtime, so a single dropped
  connection no longer leaves the document degraded. A cancel, a configuration
  error, a 4xx or a first-token timeout is still not retried.
- Each dropped attempt is recorded in the token ledger and counts toward the run's
  cost and token ceilings, and each retry is billed under its own session.
