---
issue: 399
section: Fixed
---

- A Deep Ingest in which some source files or the repository metadata failed to ingest no longer
  reports "Deep ingest complete". It now says "completed with N failures", names what failed, and
  says that automatic document regeneration was skipped. The completion message also shows edges,
  documents created and clone size again, as the old summary card did.
- When the ingest succeeds but scheduling the automatic regeneration of generated documents fails,
  the run no longer says "Repository ingestion failed". It says the repository was ingested and
  that scheduling regeneration failed, and that running the ingest again retries it.
