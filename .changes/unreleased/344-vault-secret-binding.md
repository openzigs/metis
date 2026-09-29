---
issue: 344
section: Security
---

- Behaviour change: without `vault.reveal`, a DB connector, repo connector, project primary repo
  or MCP server may reference only vault secrets the caller created, and one holding someone
  else's secret can change destination (host, port, options, Oracle service name, base URL, MCP
  command/env/…) only by clearing or replacing it: 403 `SECRET_BINDING_FORBIDDEN`, audited.
- Suggested-connector stored passwords refuse destination-choosing driver `options` and, for
  Oracle, another service name. Credential discovery never overwrites a secret a user created,
  and `mcp.json` import vaults secrets as the importing user's own.
