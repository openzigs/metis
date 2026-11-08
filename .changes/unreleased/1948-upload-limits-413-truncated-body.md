---
issue: 1948
section: Fixed
---

- Importing a clarification answers CSV over the 10 MB limit now answers
  `413 FILE_TOO_LARGE`, the same code and message the project and governing
  document uploads give, instead of `400`. An upload whose body is cut off or
  malformed now answers `400 UPLOAD_ERROR` on all three routes instead of a
  server error, and an upload rejected for an over-long form field now says so
  instead of asking for one file.
