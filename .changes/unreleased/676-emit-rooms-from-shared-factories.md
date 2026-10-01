---
issue: 676
section: Changed
---

- The server now sends every live update for a discussion thread, chat session,
  task, analysis, publish batch, presence, connector, job or background run to a
  room named by the same shared definition the subscribing view uses, so the
  two can no longer drift apart and leave a view waiting for updates that go
  elsewhere. A lint rule rejects a hand-written room name of those kinds in
  server code. Presence rooms now accept only the known artifact types
  (`discussion`, `spec-kit-artifact`); a `presence:join` naming any other type
  is ignored.
