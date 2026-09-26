---
issue: 126
section: Added
---

- One provider contract with native tool calls (`tools` / `toolChoice`, typed
  tool-call results) and structured output on both the OpenAI-compatible and
  the Anthropic Messages clients; `openai`, `azure` and `bedrock-gateway` now
  use the direct clients instead of the Copilot SDK.
- A server-side model catalog (`GET /api/ai/models`) with context window,
  price and capabilities per model; both UI model pickers render from it.
