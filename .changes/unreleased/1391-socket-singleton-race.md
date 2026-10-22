---
issue: 1391
section: Fixed
---

- A page load opens one realtime (Socket.IO) connection, not one per component
  that listens for live updates. Every component now shares the same connection,
  so all of them keep working after a token refresh.
- The realtime connection is closed whenever the session ends: on sign-out, and
  when the session expires. A later sign-in in the same tab, by the same user or
  another, opens a new connection, and nothing from the previous session's
  connection reaches it.
