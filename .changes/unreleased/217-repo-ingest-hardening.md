---
issue: 217
section: Security
---

- Repository sync no longer follows a symlink swapped in after the walk checked
  a file (`O_NOFOLLOW`, an inode check and a realpath re-check); that file is
  counted unreadable and its target is never read. A file swapped for a FIFO
  is skipped instead of hanging the sync (and the connector) forever. Lockfiles and `*.min.js` are
  excluded from the index by policy. A file over `REPO_SOURCE_MAX_FILE_BYTES` is
  reported on the connector, and degrades only the generated documents whose
  scope (the repository, or its path prefixes) contains it, naming the file. Only
  one ingest runs per connector; a second one gets `409 INGEST_IN_PROGRESS`.
