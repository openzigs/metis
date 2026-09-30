---
issue: 422
section: Fixed
---

- Chat and the Workbench add a session to **Recent** once the server has
  accepted your message, not once the first word of the answer arrives. A
  message stopped, cut off by a project switch, or dropped before the answer
  started is normally stored already, yet its session used to be missing from
  Recent.
- Chat no longer adds a session to Recent when the server refuses the message
  (for example a read-only session or an exhausted budget), matching the
  Workbench.
