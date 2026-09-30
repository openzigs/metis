---
issue: 521
section: Fixed
---

- A chat reply whose connection failed mid-answer (for example, a reset
  socket) could crash the server, because nothing handled the error the
  failed connection raised. It is now logged and the reply is stopped.
