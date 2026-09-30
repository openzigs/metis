---
issue: 588
section: Security
---

- An open MCP server status connection now stops receiving a workspace's server
  updates as soon as the workspace is deleted or the user is removed from it.
  Before, a browser tab that had already subscribed kept getting that
  workspace's MCP server names, statuses and errors until it was reloaded.
