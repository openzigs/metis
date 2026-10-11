---
name: project_decline-guards-need-every-continuation-token
description: a "decline what follows" guard in a tolerant model-output parser must cover every way output can continue; a new silent success is invisible to a "does it newly throw" fuzz
metadata:
  type: project
---

A 'decline what follows' guard in a tolerant model-output parser needs its token set checked against every way the output can continue, not only the shape that was observed — here , ] } : were covered and { [ " were not; a one-off probe of sibling shapes found the hole that 30 mutants and a 1.5M-input 'does it newly throw' fuzz could not, because the regression is a new silent success, not a new throw.

Where: `continuesStructurally` in `server/src/lib/analysis/balanced-json.ts` (PR #1084, review of #1002). `{"summary":"ok","findings":[{"title":"T"}]}\n{"title":"T2"}]}` returned the leading object and dropped the second finding; on `main` it threw and the agent runner went to repair.

**Why:** mutants only test the tokens the guard already names, and a fuzz that asks "does the new code throw where the old did not" cannot see the opposite direction — the new code returning a value where the old one threw.

**How to apply:** enumerate the grammar's continuation tokens (for JSON: `,` `]` `}` `:` and the value openers `{` `[` `"`) and write one test per token. Differential-fuzz both directions: new-throws-where-old-returned AND new-returns-where-old-threw. Still open after the fix: a bare scalar continuation (`{"a":[1]} 2, 3]}`) is accepted, because a digit or `t`/`f`/`n` also starts ordinary prose.
