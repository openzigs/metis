---
name: compaction-truncates-evidence
description: Transcript compaction cuts older tool results to 600 chars; the agentic final-answer retry was written over that cut transcript.
metadata:
  type: project
---

Transcript compaction (#1225, on by default) shortens every older tool result to its first 600 characters. The agentic final-answer retry was written over that shortened transcript, so code-agent findings claimed files were "truncated after the header" (#726). The full text stays in `toolCalls[].result`; `server/src/lib/analysis/agentic-evidence.ts` hands it back to the model.

**Why:** "truncated / not readable" in findings is usually compaction, not the read tool.

**How to apply:** check compaction before blaming tools, and give any final-answer step the full evidence, not the compacted transcript.
