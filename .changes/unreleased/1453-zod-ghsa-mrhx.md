---
issue: 1453
section: Security
---

- zod moves to 4.6.7, closing GHSA-mrhx-c7xc-m3w5 (an oversized collection could
  exhaust memory during validation) for the server, the shared package and the
  Anthropic and MCP SDKs.
- The Teams SDK's own zod 3 copy has no patched release and the SDK cannot run on
  zod 4. It is covered by a dated waiver scoped to that one copy, after confirming
  unauthenticated requests cannot reach the vulnerable validation. The waiver
  expires on 2027-01-23.
