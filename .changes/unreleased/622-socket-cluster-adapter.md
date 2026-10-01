---
issue: 622
section: Security
---

- On a multi-replica Postgres deployment, a SCIM deprovision now closes the
  user's live connections on every replica, and a role change makes them
  reconnect with the new role on every replica; workspace member removal and
  deletion stop MCP status updates on every replica too, including for a
  connection or subscription that was mid-way through on another replica when
  the change landed. Most room updates now
  reach every replica, but presence avatars still show only users on the
  viewer's own replica. No new setting; up to two extra database connections
  per replica. Without CREATE on the schema the server logs an error and keeps
  single-replica behaviour.
