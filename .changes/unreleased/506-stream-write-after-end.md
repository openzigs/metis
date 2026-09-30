---
issue: 506
section: Fixed
---

- A chat reply stopped by its time limit (or by waiting too long for the local
  model) could crash the server. After the limit had already ended the reply,
  the stopped turn tried to write a second error message to it, which surfaced
  as an unhandled error whenever the connection was still open. The second
  message is now dropped.
