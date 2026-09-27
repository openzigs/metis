---
issue: 214
section: Fixed
---

- Native tool calls in analysis (`ANALYSIS_NATIVE_TOOL_CALLS`, still off by
  default): when a pass hit the turn cap and the final-answer retry repeated the
  findings JSON the model had written next to its last tool call, that valid
  answer was thrown away and the pass degraded. It is now accepted.
