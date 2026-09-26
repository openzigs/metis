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
- New `OPENAI_*` / `AZURE_OPENAI_*` settings (a blank value counts as unset)
  and `AI_MODEL_CATALOG_OVERRIDES`. Behind DeepSeek's Anthropic-compatible
  endpoint the catalog lists only the configured and overridden models,
  unpriced unless `MODEL_PRICES` prices them.
