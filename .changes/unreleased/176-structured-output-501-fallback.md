---
issue: 176
section: Fixed
---

- A local runtime that answers HTTP 501 "structured output is unavailable"
  (Ollama's MLX engine) now gets the same single retry without
  `response_format` as a 400/422, on both chat and streaming calls, and that
  model is not sent `response_format` again. A 501 about anything else still
  fails as before.
