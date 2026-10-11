---
issue: 1077
section: Added
---

- DeepSeek can be run through its OpenAI-format endpoint (`AI_PROVIDER=openai`,
  `OPENAI_BASE_URL=https://api.deepseek.com`) with JSON mode on the steps that need JSON:
  a `json_schema` request is sent as `json_object`, the only mode DeepSeek documents, instead of
  being rejected and retried with no constraint. Requirements extraction and deep dive now ask for
  JSON mode on every provider that has one. Not yet measured against the Anthropic-format path.
