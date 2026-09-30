---
name: write-after-end-is-an-error-event
description: res.write after end is emitted as 'error', not thrown
metadata:
  type: project
---

Node emits ERR_STREAM_WRITE_AFTER_END as an 'error' event on the next tick; try/catch around res.write catches nothing and an unlistened 'error' crashes the process (#506, #521, #541).

**Why:** Guard every SSE write with res.writableEnded and add a logging res.on('error').

**How to apply:** Tests must assert writes-after-end are empty AND that the listener logs; a no-op listener passes a not-throws test (#546).
