---
issue: 465
section: Fixed
---

- A job that is still running no longer drops out of the "jobs running"
  indicator after a network blip or a token-refresh reconnect. The indicator
  now re-joins each job's updates when the connection comes back and waits for
  the server's answer again, instead of giving up on the job while offline.
