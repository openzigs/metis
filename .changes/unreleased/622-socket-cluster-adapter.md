---
issue: 622
section: Security
---

- On a multi-replica deployment, deprovisioning a user through SCIM now closes
  that user's open live connections on every server replica, not only the one
  that handled the request. Removing a member from a workspace, or deleting a
  workspace, likewise stops MCP status updates to that member on every replica.
  Live updates sent to a room also reach users connected to any replica. This
  is automatic on a Postgres database and needs no new setting; it uses up to
  two extra database connections per replica. Single-replica setups on SQLite
  are unchanged.
