---
issue: 344
section: Security
---

- Behaviour change: a vault secret used by reference is bound to its destination. Without
  `vault.reveal` (non-admins), a DB connector, repo connector, project primary repo or MCP server
  (create, PATCH, `mcp.json` import) may reference only secrets the caller created; a connector or
  server already holding someone else's secret keeps working, but its destination (DB driver, host,
  port, driver options; repo provider, API base URL; MCP runtime, command, args, URL, headers, env,
  egress allow-list) can change only if the same write clears or replaces that secret. Refusals
  answer 403 `SECRET_BINDING_FORBIDDEN` and are audited as `vault.binding_refused`. Admins are
  unaffected: ask one to bind a shared secret.
- Behaviour change: provisioning a suggested connector with its stored password refuses driver
  `options` other than the table/column `allowList` (403 `STORED_SECRET_DESTINATION_MISMATCH`).
