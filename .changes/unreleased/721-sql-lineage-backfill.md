---
issue: 721
section: Fixed
---

- SQL lineage now backfills on a repository that was already ingested. Turning SQL lineage on,
  or adding a database connector whose schema changes what lineage resolves, used to have no
  effect until a file's content changed, because Deep Ingest and Sync skip unchanged files. The
  next ingest now re-parses every file when the lineage settings or the database schema differ
  from those the code graph was built with. A graph built before this release is re-parsed once
  on its next ingest if lineage is on.
- The Gap Report's SQL-lineage coverage no longer counts ordinary code-to-code calls as table
  edges. A project with no SQL lineage used to read "100% resolved" over thousands of code calls;
  it now shows no coverage section.
