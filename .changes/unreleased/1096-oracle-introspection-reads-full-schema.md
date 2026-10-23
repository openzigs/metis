---
issue: 1096
section: Fixed
---

- An Oracle schema with more than 10,000 columns is now read in full. The read
  used to stop there with no error, so the database document and the
  architecture document's Data Architecture section left out tables while
  showing as ready.
- A read that is too large for one pass (over 250,000 column rows) now says so:
  "The schema was read partially: N of M tables". You see it in the database
  document, which is no longer marked ready, in the Data Architecture section,
  in the schema graph and in chat answers about the schema.
