---
issue: 486
section: Fixed
---

- After a socket reconnect the browser re-joins each followed job's room once, instead of once per
  component following it, and no longer sends an extra `subscribe:job` on the first connect. A
  page showing one job in several places (the Documentation page mounts four followers for a
  generating doc) now costs the server one replay and one access check per job on reconnect.
