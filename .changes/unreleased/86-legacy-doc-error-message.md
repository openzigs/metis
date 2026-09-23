---
issue: 86
section: Security
---

- A document generated before the warnings column existed no longer shows raw
  exception text. That older `errorMessage` field held warning JSON with the
  exception embedded in it and was served verbatim for any non-failed document,
  so provider response bodies, server file paths and SQL text could reach the
  documentation banner. Its content is now run through the same fixed set of
  failure messages as every other path, and anything that is not a warning list
  collapses to the generic message.
