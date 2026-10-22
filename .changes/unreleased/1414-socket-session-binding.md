---
issue: 1414
section: Security
---

- A realtime connection now ends with the session that opened it. Signing out
  closes that session's live connections (other browsers and devices stay
  connected) and refuses their reconnection; revoking a user's sessions closes
  all of theirs and refuses reconnection with any earlier sign-in token. A connection whose sign-in token expires is closed too, and a
  client that is still signed in reconnects with its renewed token.
