---
issue: 658
section: Security
---

- A real-time (Socket.IO) event handler that throws or fails can no longer take the
  whole API server down. The failure is logged with the event name, and the user's
  connection and everyone else's stay up.
