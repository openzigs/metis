---
name: docs-gen-model-keys
description: Docs-gen 'Grounding Source Key'/S1/[^storage] tables were written by the model because assembly stripped every [facts:] marker.
metadata:
  type: project
---

Before #737, docs-gen assembly removed every `[facts:…]` citation marker (`stripLeakedSourceIds`), so readers saw empty `(,,,)` and the model invented its own "Grounding Source Key" tables, `S1` handles and `[^storage]` footnotes from raw URL-encoded ids. No METIS code produced those. #737 now renders markers as `[^src-N]` GFM footnotes (`server/src/lib/docs-gen/citation-footnotes.ts`).

**Why:** odd citation artefacts in generated docs are usually model output, not a renderer bug.

**How to apply:** when a generated doc shows strange citation tables, check what assembly strips before changing a renderer.

## Output ceilings are shared with Spec Kit; non-streaming calls are capped (#1285 review)

- A ceiling row in `docs-gen/output-caps.ts` also changes Spec Kit's default (`spec-kit/output-budget.ts`). Any ceiling-table edit needs a Spec Kit impact line. An always-reasoning id with no ceiling row gets an unclamped 8,192 tokens plus the reasoning allowance.
- The Anthropic provider caps every non-streaming call at 21,333 tokens (`anthropic-provider.ts:372`), so a `max_tokens` or allowance change affects only streamed calls.
