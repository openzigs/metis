---
issue: 111
section: Fixed
---

- The local model's time-to-first-token budget is configurable with
  `LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS` (plus `LOCAL_GEMMA_IDLE_TIMEOUT_MS` and
  `LOCAL_GEMMA_REQUEST_TIMEOUT_MS`). A large prompt no longer hits a fixed
  10-minute limit, and a timeout reports the prompt size and names the setting
  instead of asking whether the model is running.
