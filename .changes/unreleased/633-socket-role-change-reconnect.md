---
issue: 633
section: Security
---

- Changing a user's role now reaches their open real-time connections. When a
  role is changed through SCIM group membership, a SCIM group deletion, an
  administrator's role reconciliation, or a sign-in that brings a different role
  from the identity provider, the server closes that user's live connections and
  the browser reconnects on its own with the new role. A demoted administrator
  stops receiving admin-only live updates straight away instead of keeping them
  until they reconnect. This reaches connections held by the server instance
  that made the change; other instances of a multi-instance deployment are not
  reached yet (#622).
