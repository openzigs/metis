---
issue: 756
section: Fixed
---

- Deep Ingest, Sync and the scheduled refresh of a repository connector now
  remove the connector's source documents whose files are no longer in the
  checkout (deleted upstream, or absent from the branch or tag the connector now
  pins), together with their vectors, so retrieval and chat stop citing them.
  Only that connector's source documents in that project are candidates; a file
  still present but skipped by the file budget or a policy keeps its document,
  and a checkout with no source files at all prunes nothing.
