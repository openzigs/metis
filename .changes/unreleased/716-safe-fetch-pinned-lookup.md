---
issue: 716
section: Fixed
---

- Adding a document from a public URL works again. On Node 20 and later every URL was rejected
  with `URL_NOT_ALLOWED`, because the server's guarded HTTP client answered Node's address lookup
  in the wrong shape and the connection never opened. The same fix restores HTTP MCP servers,
  PagerDuty events and eval drift alerts, which use the same client.
