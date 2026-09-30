---
name: markdown-sections-cost-and-harness
description: markdown-sections.ts: cache every parsed line; use the DOCUMENTS harness; probe per-line regex changes with mixed CRLF
metadata:
  type: project
---

PR #556 parsed candidate definitions through the next blank line but cached only positive results, which made hostile blank-free runs O(n^2) (87s at 36 KB). The whole-document-equality DOCUMENTS table in markdown-sections.test.ts splits regressions from pre-existing mismatches (#542).

**Why:** Untrusted markdown reaches the section splitter; quadratic paths freeze the main thread.

**How to apply:** Cache every line a parse covers; bound cost tests on characters parsed or normalisation calls, never wall-clock; probe new cases against origin/main's file too.

**Mixed line endings (#569/#564).** The splitter splits on `\n` only, so on a CRLF line every per-line regex sees a trailing `\r`. Replacing `trim()` with `/^[ \t]*$/` broke blank-line detection, and the fix is `/^[ \t]*\r?$/`. A pure-CRLF document never splits, because HEADING never matches, and that hides the bug. Any change to a line-classifying regex (blank, fence, heading, definition) needs a DOCUMENTS row with mixed endings.

**Probe placement (#594, #598).** A divergence from micromark (trim, `\s`, a block-start miss) only shows in a DOCUMENTS row when the divergent definition comes *first*, or when the line follows a footnote definition's paragraph (`[^1]: One`, the line, `After.`). A PR claiming a difference "cannot be pinned" was wrong there.
