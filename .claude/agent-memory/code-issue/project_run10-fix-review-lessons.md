---
name: run10-fix-review-lessons
description: Durable findings from the code reviews of the walkthrough run 10 fixes (#1567-#1575, #1570, #1571) - escaping, metadata writers, abort tests, throttle tests, Word exporter.
metadata:
  type: project
---

From the reviews of PRs #1593-#1601, 2026-10-30.

- **Escaping in `Requirement.body` (#1567):** check the plain-text views as well as the
  Markdown renderers. `VersionDiff` (review card field diff) and `requirement-diff.tsx` show
  the raw stored string, so entity-encoding that is right in Markdown shows as literal `&lt;`.
- **`Analysis.metadata` writers (#1569):** a new writer to a key is only as safe as every
  other writer to it. The clarify submit route reads `structuredRequirements` before its LLM
  call and replaces the whole list afterwards, so a locked append elsewhere can be silently
  undone (#1602). Check both directions of a "concurrent rewrite is not lost" claim.
- **Abort/unmount tests in the UI (#1573):** mocked `streamChat` generators often *return*
  when the signal aborts, but the real fetch *throws* `AbortError`, so the test skips the
  abort/finally path production takes. Make the mock throw `DOMException('AbortError')`.
- **Throttle tests with fake timers (#1570):** advancing by a full window cannot tell a
  correct trailing delay from 0 ms. Assert at `window - 1` ms.
- **Word exporter (#1571):** `parseInlineFormatting` in `server/src/lib/docs-gen/exporters.ts`
  emits each bold/italic/link token as one flat run and parses nothing inside it. Test every
  new inline token nested in bold, italic and link text, and check for leaked sentinel
  characters, not only raw source markers.
