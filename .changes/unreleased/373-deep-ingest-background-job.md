---
issue: 373
section: Fixed
---

- Deep Ingest on a large repository no longer shows a 500 after five minutes while the ingest
  carries on and succeeds. The request now returns at once and the ingest runs in the background:
  the button reads "Ingesting…" until the run ends, then the page shows the result or the failure.
  Clicking Deep Ingest again while a run is in progress says that one is already running and
  follows it, instead of answering with a bare 409.
