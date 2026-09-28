---
issue: 313
section: Fixed
---

- A repository re-sync no longer leaves cross-file code-graph edges unbound.
  An incremental ingest re-parses only changed files, and until now resolved
  their edges against those files alone, so a changed file's calls into
  unchanged code, and unchanged code's calls into a changed file, lost their
  target until the next full ingest. "Who calls X", impact analysis and
  generated docs silently saw fewer callers after every re-sync. Edges now bind
  exactly as a full ingest of the same tree would, for every language
  (including COBOL `COPY`), without re-parsing files a change cannot affect.
- Files deleted from a repository are removed from its code graph on the next
  re-sync, so edges no longer point at code that no longer exists.
