---
issue: 112
section: Fixed
---

- Saving the same setting twice at once no longer leaves the server using the
  value that lost. The server could keep answering with the first save's value
  while the stored setting held the second, until the next restart.
- A setting whose save hits a database error still shows a fixed message, and
  the server log once again records the error's message and stack trace.
- Re-saving a cleared secret also refreshes its stored description.
