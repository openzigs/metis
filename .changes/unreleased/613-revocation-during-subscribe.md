---
issue: 613
section: Security
---

- A workspace deletion, a member removal, a role change or a deprovision now
  reaches a real-time connection that was in the middle of connecting or of
  subscribing to MCP server status when the change landed. Before, a change
  that fell in that window of a few milliseconds was missed: the connection
  could still join the deleted workspace's MCP status updates, or keep the old
  role, until it reconnected.
