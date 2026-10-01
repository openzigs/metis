---
issue: 654
section: Security
---

- A signed-in user could crash the API process by sending a realtime
  subscribe, unsubscribe, presence or typing event with an empty payload. The
  server now ignores such events and the connection keeps working.
