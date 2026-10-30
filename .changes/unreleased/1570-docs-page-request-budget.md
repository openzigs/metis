---
issue: 1570
section: Fixed
---

- The Documentation page no longer trips its own rate limit while a document generates. It
  re-reads the document list and the generating document at most every 10 seconds, instead of
  re-reading every open document on each progress update (about 3 requests a second). A page that
  is rate limited anyway waits for the time the server gives and then catches up, instead of
  freezing on its last state.
