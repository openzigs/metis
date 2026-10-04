---
name: docs-gen-model-keys
description: Docs-gen 'Grounding Source Key'/S1/[^storage] tables were written by the model because assembly stripped every [facts:] marker.
metadata:
  type: project
---

Before #737, docs-gen assembly removed every `[facts:…]` citation marker (`stripLeakedSourceIds`), so readers saw empty `(,,,)` and the model invented its own "Grounding Source Key" tables, `S1` handles and `[^storage]` footnotes from raw URL-encoded ids. No METIS code produced those. #737 now renders markers as `[^src-N]` GFM footnotes (`server/src/lib/docs-gen/citation-footnotes.ts`).

**Why:** odd citation artefacts in generated docs are usually model output, not a renderer bug.

**How to apply:** when a generated doc shows strange citation tables, check what assembly strips before changing a renderer.
