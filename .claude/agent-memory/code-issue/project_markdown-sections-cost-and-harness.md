---
name: markdown-sections-cost-and-harness
description: markdown-sections.ts: cache every parsed line; use the DOCUMENTS harness
metadata:
  type: project
---

PR #556 parsed candidate definitions through the next blank line but cached only positive results, which made hostile blank-free runs O(n^2) (87s at 36 KB). The whole-document-equality DOCUMENTS table in markdown-sections.test.ts splits regressions from pre-existing mismatches (#542).

**Why:** Untrusted markdown reaches the section splitter; quadratic paths freeze the main thread.

**How to apply:** Cache every line a parse covers; bound cost tests on characters parsed or normalisation calls, never wall-clock; probe new cases against origin/main's file too.
