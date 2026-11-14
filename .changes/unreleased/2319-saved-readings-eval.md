---
issue: 2319
section: Changed
---

- The document-understanding eval's reader arm (`--arms R`) now reads each
  document the way an analysis does, saving the reading. With
  `--saved-readings`, a second run reuses that saved reading instead of
  reading the document again, and the report says what the reuse cost and
  whether it matched the saved reading.
