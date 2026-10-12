---
name: zero-findings-read-token-usages-first
description: To diagnose a run where an agent returned nothing, read token_usages for the analysis: an output count equal to the cap with an empty reply is reasoning exhaustion.
metadata:
  type: project
---

When an analysis stage ends with nothing (code agent "0 findings recovered", "Failed to parse LLM response as JSON", an empty Spec Kit artifact), the cause is usually visible in one query, with no log needed:

```sql
SELECT createdAt, inputTokens, outputTokens FROM token_usages
WHERE sessionId = '<analysisId>' ORDER BY createdAt;
```

`token_usages.sessionId` is the analysis id (#724). A row whose `outputTokens` equals a configured output cap exactly (16384 for `ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS`, 16000 for the anthropic provider default, 21333 for the SDK non-streaming bound) next to an empty reply means the model spent the whole cap reasoning. In #706 run 7 (`deepseek-flash`) three consecutive calls of one analysis did this: the final-answer retry, the evidence-only salvage, and the requirements extractor.

**Why:** DeepSeek's models reason by default and draw reasoning from `max_tokens`; the dev log line `Final-answer retry completed {"responseLength":0,"finishReason":"max_tokens"}` says the same but is not persisted.

**How to apply:** fix it per call site with `resolveReasoningSetting(<KEY>, model)` from `server/src/lib/docs-gen/docs-gen-reasoning.ts` (`auto` = `low` effort only for a thinks-by-default model), as #25, #1057 and #1063 did, and register the key in `key-registry.ts` (then update the `key-registry-parse-semantics` snapshot with `-u`). The dev DB is 1.5 GB: clone it with `cp -c` and open the copy read-only.
