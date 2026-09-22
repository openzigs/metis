---
issue: 15
section: Fixed
---

- Chat and analysis now run every tool a model asks for in one reply —
  consecutive JSON objects, a JSON array, or a `<tool_calls>` wrapper,
  including the nested form DeepSeek emits — in order, and return all the
  results on the next turn. Before, such a reply ran nothing: chat showed the
  raw tool markup as the answer and the code agent stopped after one call.
  Tool markup that cannot be parsed is never shown as an answer.
