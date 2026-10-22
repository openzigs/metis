---
issue: 1391
section: Fixed
---

- A page load opens one realtime (Socket.IO) connection, not one per component
  that listens for live updates. Every component now shares the same connection,
  so all of them keep working after a token refresh.
- Signing out closes the realtime connection. Signing in again in the same tab
  opens a new connection under the new session.
