---
issue: 541
section: Fixed
---

- Streamed AI replies in discussion threads can no longer take the server down:
  a reply chunk that arrives after the stream has closed is dropped, and an
  error on the reply's connection is logged instead of going unhandled — the
  same guards #506 and #521 gave the chat stream.
