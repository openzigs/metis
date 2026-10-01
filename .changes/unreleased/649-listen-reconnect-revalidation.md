---
issue: 649
section: Security
---

- On a multi-replica Postgres deployment, a replica whose cross-replica connection to
  Postgres drops (failover, restart or a killed connection) now re-checks every live
  connection it holds once it reconnects. A user deprovisioned, given a new role, or
  removed from a workspace during the few seconds that connection was down is now
  disconnected, reconnected with the new role, or taken out of that workspace's MCP
  status updates. Before, the replica kept that access until the connection next
  reconnected.
