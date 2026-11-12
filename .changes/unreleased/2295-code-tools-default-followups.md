---
issue: 2295
section: Changed
---

- A model that cannot call tools natively (for example some local Ollama runtimes) no longer gets
  chat's code-search tools by default. On such a model they run through the text-protocol tool
  loop, which does not stream and has not been measured. Set `CHAT_CODE_SEARCH_TOOLS=true` to
  offer them there as well. Models with native tool calls keep them on by default.
- Settings > Configuration shows an unset setting at the value the server applies. `CHAT_TOOLS`,
  `CHAT_CODE_SEARCH_TOOLS`, `CHAT_PROGRESSIVE_SKILLS` and `CHAT_SUBAGENTS` are on by default and
  now show as checked, with the source `default`, instead of looking switched off.
