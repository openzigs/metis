---
issue: 622
section: Security
---

- On a multi-replica Postgres deployment, a SCIM deprovision now closes the
  user's live connections on every replica, and a role change makes them
  reconnect with the new role on every replica; workspace member removal and
  deletion stop MCP status updates on every replica too, including for a
  connection or subscription mid-way through on another replica. Room
  updates reach every replica and never wait on the database for the
  replica's own users.
  No new setting; up to two extra database connections per replica. Without
  CREATE on the schema the server logs an error and keeps single-replica
  behaviour.
