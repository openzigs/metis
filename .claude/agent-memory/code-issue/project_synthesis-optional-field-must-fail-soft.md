---
name: synthesis-optional-field-must-fail-soft
description: Synthesis repairs its reply field by field (synthesis-reply-repair.ts) since #1099; a new model-output field must be added to that repair, or one bad value discards every requirement again.
metadata:
  type: project
---

Since #1099, `runSynthesis` (`server/src/lib/analysis/synthesis.ts`) runs
`repairSynthesisReply` (`server/src/lib/analysis/synthesis-reply-repair.ts`) before
`synthesisOutputSchema`. Each repairable field has a rule — `null` reads as absent,
an unusable value is dropped / defaulted / shortened, a requirement without a title
or body is dropped alone — and every repair is recorded (`fieldRepairs` →
`metadata.synthesisFieldRepairs` → `SynthesisFieldRepairsNotice`).

**Why:** before #1099 the whole reply was validated at once, so `storyPoints: null`
on one requirement discarded every requirement: `schema-invalid`, a second billed
call, then the keyword fallback (#1063 found it with `sourceIds`, which is why that
field and `structuredIds` fail soft in the schema itself with `.catch`).

**How to apply:**

- A NEW field the synthesis model writes needs either a `.catch` in
  `synthesizedRequirementSchema` (display-only fields) or a rule in
  `repairSynthesizedRequirement` plus a wording case in `@metis/shared`
  `synthesis-field-repairs.ts` (published fields: say what is lost).
- Test it through the real `runSynthesis` with a stub provider
  (`server/tests/analysis-synthesis-field-repair-1099.test.ts` is the table to
  extend): one call, the neighbour requirement kept, the repair recorded.
- Do NOT add the helper to `synthesis.ts` as a value export: ten pipeline suites
  `vi.mock("./synthesis.js")` exposing only `runSynthesis`.
