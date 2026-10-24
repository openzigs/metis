---
issue: 1499
section: Security
---

- Rotating a vault secret now clears the recorded repository access of every
  connection that uses it, so a rotated token no longer keeps its predecessor's
  admin or push access for shared-secret pull request reviews. A Test or sync
  already in flight when the secret rotates records nothing.
- A metadata sync that overlaps a change to its connection now ingests nothing.
- The boot re-check of repository access skips connections that another
  replica has already re-checked, and a DNS failure while it pins the GitHub
  host no longer marks a connection as errored.
