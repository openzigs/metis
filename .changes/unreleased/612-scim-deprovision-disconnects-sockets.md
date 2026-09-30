---
issue: 612
section: Security
---

- A SCIM deprovision (DELETE, or PATCH `active: false`) now disconnects every
  open real-time connection of that user. It used to revoke sessions only, so a
  deprovisioned user's open browser tab kept receiving live events — MCP
  workspace server status included — until it happened to disconnect.
- A deprovisioned or disabled user's workspace memberships no longer authorize
  anything: reconnecting with a not-yet-expired access token joins no workspace
  room.
