---
issue: 1370
section: Security
---

- Repository text in a generated document's sources, formulas, module facts,
  end-to-end flow, canonical facts and schema can no longer close or forge the
  writer prompt's `=== … ===` blocks or a `[SOURCE id=…]` header, exactly or
  through a Unicode look-alike. Clean text reaches the model unchanged.
