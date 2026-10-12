---
name: synthesis-optional-field-must-fail-soft
description: A new optional field requested from the synthesis model must fail soft in synthesizedRequirementSchema, because runSynthesis validates the whole reply and one malformed value discards every requirement.
metadata:
  type: project
---

A new optional field requested from the synthesis model must fail soft in `synthesizedRequirementSchema` (`packages/shared/src/analysis.ts`). `runSynthesis` (`server/src/lib/analysis/synthesis.ts`) validates the whole reply with `synthesisOutputSchema`, so one malformed value (e.g. `null`) on one requirement discards every requirement: `schema-invalid`, a second billed call, then the findings-as-requirements fallback.

**Why:** #1063 added `sourceIds: z.array(z.string().min(1).max(32)).max(20).optional()`, a field that only says where a card came from. A review probe through the real `runSynthesis` showed `sourceIds: null`, a bare string, `[""]`, a number, an id written with its title (over 32 characters) or 21 ids each cost the whole reply. Tests that pinned the rejection at the schema passed; nothing fed a malformed value through `runSynthesis`. Caps bought nothing either: `cleanSourceIds` already drops every id the run does not list.

**How to apply:**

- Write the field as `z.array(z.string().catch("")).optional().catch(undefined)` (zod 4: an absent key stays absent, `null` reads as absent), and do the real checking after the parse.
- Probe any new model-output field with `null`, the wrong type and over-cap values through the real `runSynthesis` with a stub provider: assert one call, every requirement kept, and the bad field read as not recorded.
- The same strictness is still in the older fields, and none of them was changed in #1063 because none is display-only: `storyPoints: null` (the prompt writes `<optional int>`), a `labels` or `acceptanceCriteria` entry over its cap or `null`, a non-integer in `evidenceFindingIndexes`, and an unknown `type` or `priority` each discard the reply the same way.
