---
issue: 111
section: Fixed
---

- The local model's time-to-first-token budget is configurable with
  `LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS` (plus `LOCAL_GEMMA_IDLE_TIMEOUT_MS` and
  `LOCAL_GEMMA_REQUEST_TIMEOUT_MS`). A large prompt no longer hits a fixed
  10-minute limit, and a timeout reports the prompt size and names the setting
  instead of asking whether the model is running.
- The timeout settings accept plain digits only, up to about 24.8 days. A value
  such as `1_200_000`, `1.2e6` or `3000000000` now keeps the default and logs a
  warning, instead of silently becoming a 1 ms timeout.
