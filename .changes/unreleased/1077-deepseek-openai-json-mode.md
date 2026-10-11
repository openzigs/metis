---
issue: 1077
section: Added
---

- DeepSeek can be run through its OpenAI-format endpoint (`AI_PROVIDER=openai`,
  `OPENAI_BASE_URL=https://api.deepseek.com`) with JSON mode on the steps that need JSON:
  a `json_schema` request is sent as `json_object`, the only mode DeepSeek documents, instead of
  being rejected and retried with no constraint. Not yet measured against the Anthropic-format path.
- Behaviour change for existing configurations: a model already marked `jsonSchema:false` in
  `AI_MODEL_CATALOG_OVERRIDES` now receives `json_object` where it used to receive the schema
  verbatim, and requirements extraction and deep dive ask it for `json_object` too. Add
  `"jsonObject":false` to that entry to keep the old behaviour.
