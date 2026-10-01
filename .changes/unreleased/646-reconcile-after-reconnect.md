---
issue: 646
section: Fixed
---

- Live views catch up after the realtime connection drops and comes back. An
  update sent while the connection was down used to be lost, so a scan that
  finished in the gap still showed as running, and a new discussion message,
  mention, drift count, document status, task, scheduler job, publish batch,
  test-coverage run or approval gate stayed out of date until the next update
  or a reload. Each view now re-reads its data on reconnect, and a view
  opened while the connection was down re-reads once it connects. On a
  discussion longer than 100 messages the missed messages are recovered too.
