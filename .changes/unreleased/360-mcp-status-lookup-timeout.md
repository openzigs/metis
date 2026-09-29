---
issue: 360
section: Fixed
---

- MCP server status updates no longer stop arriving when looking up a project MCP server's project hangs. The lookup now gives up after five seconds and that one update goes to system admins only; later updates, for every kind of server, keep flowing.
