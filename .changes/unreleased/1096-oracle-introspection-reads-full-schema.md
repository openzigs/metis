---
issue: 1096
section: Fixed
---

- An Oracle schema with more than 10,000 columns is now read in full. The read
  used to stop there with no error, so the database document and the
  architecture document's Data Architecture section left out tables while
  showing as ready.
- A database too large to read in one pass (over 250,000 columns) now says how
  much was read: "N of M tables are described". You see it in the database
  document, which is no longer marked ready, in the Data Architecture section,
  in the schema graph and in chat answers about the schema.
