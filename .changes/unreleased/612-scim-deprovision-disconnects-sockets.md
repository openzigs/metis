---
issue: 612
section: Security
---

- A SCIM deprovision (DELETE, or PATCH `active: false`) now disconnects the
  user's open real-time connections on the server instance that handled the
  request. It used to revoke sessions only, so a deprovisioned user's open
  browser tab kept receiving live events — MCP workspace server status
  included — until it happened to disconnect. On a multi-replica deployment,
  connections held by other replicas are not yet closed (#622).
- A deprovisioned or disabled user's workspace memberships no longer authorize
  anything: reconnecting with a not-yet-expired access token joins no workspace
  room.
