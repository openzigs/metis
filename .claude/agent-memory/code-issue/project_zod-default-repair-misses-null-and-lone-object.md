---
name: zod-default-repair-misses-null-and-lone-object
description: A zod .preprocess/.default([]) repair at the model boundary covers only undefined; null or a lone object for an array field still fails the whole parse.
metadata:
  type: project
---

In this repo, a zod `.preprocess` / `.default([])` repair at the model boundary only covers `undefined`: a model writing `null` for an array field still fails the whole parse, and so does a lone object where the array belongs. #1143's first cut salvaged bad elements inside `citations` but left `citations: null` and `citations: {…}` failing the entire agent (code review, PR #1152).

**Why:** `.default()` fires only on `undefined`, and a preprocess that early-returns on `!Array.isArray(value)` hands `null` and a bare object straight to `z.array`, which rejects them — taking every finding of that agent with it.

**How to apply:** when reviewing or writing model-output salvage, probe `null` and a lone object for each array field, not just bad elements inside the array. `salvageCitationList` in `packages/shared/src/analysis.ts` is the pattern: `null` → `[]`, lone value → `[value]` then validated, and the counts returned to the caller.
