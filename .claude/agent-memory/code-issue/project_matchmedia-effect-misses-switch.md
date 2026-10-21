---
name: matchmedia-effect-misses-switch
description: A React effect that calls window.matchMedia(q) with a frequently-changing dependency can miss a media switch (#1307).
metadata:
  type: project
---

Found on PR #1307 (print renders every section).

Each `window.matchMedia(q)` call returns a new `MediaQueryList` that starts in the current state, and only a list whose state changes fires `change`. An effect that re-subscribes whenever a frequently-changing dependency moves can create its list just after the switch, so it never sees the event and the component misses the change (e.g. `print`).

**Fix:** subscribe once, and read `.matches` when subscribing, so a switch that happened before the listener existed is still seen.
