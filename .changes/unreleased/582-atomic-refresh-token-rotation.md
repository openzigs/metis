---
issue: 582
section: Security
---

- Refresh-token rotation is single-use under concurrency. Two refreshes that
  presented the same refresh token at the same moment could both succeed and
  each receive a new token pair, because the "already revoked?" check and the
  revocation were separate steps. The revocation is now one atomic
  insert-if-absent on the token id, and only the request that wins it gets new
  tokens; the other is refused as revoked. A SCIM deprovision that lands during
  a refresh now also refuses the new pair.
- The UI's page-level refresh is single-flight per refresh token, so a page
  load with several parallel requests (or two tabs) after the access cookie
  lapses shares one refresh instead of logging the user out.
