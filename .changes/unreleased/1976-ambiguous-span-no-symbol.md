---
issue: 1976
section: Fixed
---

- A code citation whose lines exist in more than one connected repository, and which does not
  name its repository, is now saved as a link to the file and lines only. It stays unverified.
  Before, it was tied to one repository's symbol by guesswork, and the next re-ingest of that
  repository marked the guess fresh. A citation that names its repository is still tied to that
  repository's symbol and verified as before.
