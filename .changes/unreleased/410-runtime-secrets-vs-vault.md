---
issue: 410
section: Changed
---

- Settings → Configuration now says what Runtime secrets are: server
  configuration values the server itself reads, such as provider API keys.
  Connector, MCP and publishing credentials belong in the Vault, which the
  section links to. The Vault page links back to Settings → Configuration for
  server config, shown only to admins, who are the only role that can open it.
