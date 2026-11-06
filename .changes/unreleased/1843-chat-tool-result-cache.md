---
issue: 1843
section: Changed
---

- Chat reuses the result of a code or document search it already ran in the last 30 minutes, as
  long as the project's code and documents have not changed since. Re-ingesting a repository,
  uploading, editing or deleting a document, or switching the embedding model makes the next
  search run fresh. Operators can turn the cache off with `CHAT_TOOL_RESULT_CACHE_ENABLED=0` and
  watch hits and misses on `metis_chat_tool_result_cache_total`.
