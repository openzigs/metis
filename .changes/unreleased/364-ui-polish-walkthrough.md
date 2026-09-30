---
issue: 364
section: Fixed
---

- Local and uploaded repository connections show their source and ingest state, not
  "null/null" and "pending", colour a failed ingest red, and no longer ask for a token.
- Approve/Reject are disabled once an approval is decided, so a second click cannot 409.
- Analysis and Publish name runs "Run #N — <date>"; review-note boxes no longer read out UUIDs.
- The upload row no longer says "queued · 0 chunks" while indexing continues.
- Code Overview's empty state no longer logs a 404; a failed load shows an error, not a blank page.
- "Before you start" is in the future tense, and Publish pre-fills owner and repo once,
  together, and only into empty fields.
