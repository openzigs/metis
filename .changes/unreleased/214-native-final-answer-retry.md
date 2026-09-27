---
issue: 214
section: Fixed
---

- Native tool calls in analysis (`ANALYSIS_NATIVE_TOOL_CALLS`, still off by
  default): when a pass hit the turn cap and the final-answer retry repeated the
  findings JSON the model had written next to its last tool call, that valid
  answer was thrown away and the pass degraded. It is now accepted.
- `pnpm eval:analysis-tools` now records, for every degraded pass, which
  findings-schema fields its last answer failed (`answerSchemaIssues`, field
  paths and error codes only), so a re-measurement can tell a schema failure
  from an answer rejected for another reason.
