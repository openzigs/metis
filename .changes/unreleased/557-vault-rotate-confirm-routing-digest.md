---
issue: 557
section: Security
---

- **Breaking (API):** confirming a rotation of another user's vault secret now also covers
  what the listed destination does not show. Each binding in the 409 carries a `routing`
  digest, and API clients must echo it for every binding in `confirmedBindings`; a confirm
  without it, or with anything but that 64-hex digest, gets 400. Changed MCP args or a new
  database on the same host refuse with `VAULT_ROTATE_BINDINGS_CHANGED`. A confirm now names
  at most 150 bindings (was 1,000), so the largest valid body stays under the JSON limit.
