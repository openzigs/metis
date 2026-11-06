---
issue: 1844
section: Changed
---

- The optional semantic answer cache for chat (`SEMANTIC_CACHE_ENABLED`, still off by default)
  no longer serves an answer computed before the project's code or documents changed. It also
  no longer serves an answer to another user or from a different point in a conversation. It
  tries an exact match on the question first, needs a closer match than before (0.97, was
  0.92), and never stores an answer that used a tool. Chat questions and answers are not added
  to the vector store; ADR 0022 records why.
