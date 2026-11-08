---
issue: 1944
section: Fixed
---

- Chat's tool-result cache no longer keeps re-reading a large batch of document rows after a
  repository sync. It reads only the documents written in the last minute, and none once a minute
  has passed with no document written. Checking a project's content version also no longer calls
  the embeddings sidecar, so it no longer sends a request on every cached tool call while the
  sidecar is down.
