---
issue: 241
section: Fixed
---

- A chat keeps the AI provider it started on (a project's override, or the server
  default at the time); changing either affects new chats only. A turn that fails
  after paid model calls still records their usage, once. Resuming a long chat
  loads its history in pages and ends with every message. A message waiting for
  a busy local model shows "Waiting for the local model", and that wait has its
  own limit (`AI_STREAM_QUEUE_MAX_WAIT_MS`) instead of counting against the
  response's.
