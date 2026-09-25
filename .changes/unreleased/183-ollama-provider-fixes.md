---
issue: 183
section: Fixed
---

- Local (Ollama) requests with thinking off now also send `reasoning_effort: "none"`,
  because Ollama's `/v1` endpoint ignores `think: false`. Explicit reasoning efforts are
  forwarded instead of dropped. A model that rejects the field is retried once without it
  (`LOCAL_GEMMA_SEND_REASONING_EFFORT`).
- Local requests queue inside METIS, capped per local server by `LOCAL_GEMMA_MAX_CONCURRENCY`
  (default 1); `localhost`, `127.0.0.1` and `[::1]` spellings of one server share the cap.
  A model name containing "reasoning" or "thinking" in an unrelated error is no longer
  mistaken for a `reasoning_effort` rejection. Timeouts start only once a request holds a slot, so a request queued
  behind a long generation is no longer aborted as a first-token stall.
