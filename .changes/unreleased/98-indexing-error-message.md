---
issue: 98
section: Security
---

- A document's indexing failure no longer reaches the browser as raw exception
  text (provider response bodies, file paths, stack frames) on the documentation
  status line, the documents list, the quarantine list or the `document:status`
  socket event. It is one of a fixed set of messages instead, and rows written
  before this release are sanitised when read. An unreachable AI or embedding
  host (`fetch failed`, for example a local Ollama server that is down) now says
  so, for indexing and for documentation generation alike.
