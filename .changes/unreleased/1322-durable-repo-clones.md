---
issue: 1322
section: Fixed
---

- Repository clones default to the server's data directory (`data/repo-clones`)
  instead of the OS temp dir, which macOS and container restarts purge. The Helm
  chart and both compose files set `REPO_CLONE_DIR` on the persistent data volume;
  a clone left at the old temp location is moved across on first use.
- A missing, emptied or partly purged clone is re-fetched at the code graph's exact
  commit before a document is generated. If that cannot be done, generation stops
  before any AI spend and asks you to re-ingest the repository, instead of
  producing an ungrounded document. If another job is preparing the same
  repository, it waits up to two minutes, then asks you to try again later.
