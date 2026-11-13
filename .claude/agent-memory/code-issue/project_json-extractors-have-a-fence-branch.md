---
name: json-extractors-have-a-fence-branch
description: extractJsonObject has three paths (leading brace, first json fence, balanced scan); test JSON-reliability fixes against fenced replies too (#1355, #2407, #2415).
metadata:
  type: project
---

`extractJsonObject` has three paths: a reply that starts with `{`, the **first ```json fence**, and the balanced-brace scan. A JSON-reliability fix tested only on bare or prose-wrapped replies leaves the fence branch unchecked: #1355 and #2407 both missed it.

**How to apply:** for any fix touching how a model reply becomes JSON, add a fenced case (and a fence-plus-prose case) beside the bare one. `json-llm-client`'s `extractJson` is a **second extractor** with the same need (#2415): grep for both, and fix or test both.
