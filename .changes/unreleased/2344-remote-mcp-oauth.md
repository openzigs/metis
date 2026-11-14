---
issue: 2344
section: Added
---

- **Query the METIS index from agents on other machines.** Admins can turn on a remote MCP
  endpoint at `/mcp` that serves the eight read-only `metis_*` tools over HTTP. It is off by
  default. Tokens come from your identity provider: METIS checks each one's signature, issuer,
  expiry and audience, and maps it to the METIS user who signs in with that identity. A static
  shared secret or METIS API token is refused. Every call then runs as that user, under the same
  project access and document ACLs as the stdio server, and is audit-logged without results.
  The token is never passed on to any other service. Setup: `docs/integrations/metis-index-mcp-remote.md`.
- **Helm**: `ingress.mcpRemote.enabled` routes `/mcp` and its OAuth metadata to the server.
