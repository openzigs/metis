---
issue: 0
section: Fixed
---

- Local (Ollama) requests with thinking off now also send `reasoning_effort: "none"`,
  because Ollama's `/v1` endpoint ignores `think: false`. Explicit reasoning efforts are
  forwarded instead of dropped. A model that rejects the field is retried once without it
  (`LOCAL_GEMMA_SEND_REASONING_EFFORT`).
- Local requests queue inside METIS, capped per base URL by `LOCAL_GEMMA_MAX_CONCURRENCY`
  (default 1). Timeouts start only once a request holds a slot, so a request queued
  behind a long generation is no longer aborted as a first-token stall.
