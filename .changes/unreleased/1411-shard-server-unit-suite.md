---
issue: 1411
section: Changed
---

- CI runs the SQLite server unit suite in three parallel `server-unit` shards instead of
  inside `server`, which now runs only the real-Chromium exporter suite. Neither job sits
  near its timeout any more, so a pull request is no longer cancelled red with no test
  failing. Every test file still runs.
