---
issue: 1842
section: Changed
---

- Chat on Anthropic now prompt-caches the whole tool loop, not only the system prompt. Each model
  call in a chat turn reads back the question and earlier tool results at the cached rate instead
  of paying full input price for them again. Every call's cache reads and writes are recorded in
  the usage ledger. Requests to OpenAI-compatible providers (DeepSeek, the Bedrock gateway, OpenAI,
  Azure, local runtimes) are unchanged.
