---
issue: 674
section: Fixed
---

- Live progress for a repository ingest, Spec Kit command, overview regeneration, embeddings
  reindex or pull request review now reaches you when the server runs as several instances, after
  a server restart, and when many other jobs have run since. Before, the job's own initiator could
  be refused its progress updates in those cases. People outside the job's project are still
  refused.
