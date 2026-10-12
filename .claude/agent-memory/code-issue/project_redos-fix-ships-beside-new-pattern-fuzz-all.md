---
name: redos-fix-ships-beside-new-pattern-fuzz-all
description: A ReDoS fix here tends to ship next to a new unbounded pattern; fuzz every regex literal in the touched files, and sweep a gate over LLM output across every model-chosen field.
metadata:
  type: project
---

In this project a ReDoS fix that bounds the reported pattern tends to ship beside a new unbounded one in the same commit, and timing tests cover only the patterns named in the review. Fuzzing every regex literal in the touched files (TypeScript AST extraction, about 40 adversarial 200 KB inputs, under a minute) catches this where reading the diff does not. Separately, a gate over LLM output must be swept over every field the model chooses (table, column name, type), not just the field the last review named.

**Why:** PR #1090 (#1036, #791, #1051) failed two reviews on both counts. Review 1 found `/\b\S+\s+(units)\s+(old|ago)\b/i` (14 s at 160 KB); the commit that bounded it added `BOLD_HEADING_LINE` ending in `\s*:?\s*$` (23 s at 200 KB), and the timing tests it added covered only the gate's patterns. The first run of the fuzz then found a third nobody had reported (`/\([^)]*\)\s*$/` in `extract-changes.ts`, 15 s). The gate went the same way: review 1 named the declared-writer field, the fix swept that field, and review 2 walked in through the table, the column name and the type.

**How to apply:**

- The fuzz is `server/src/lib/impact-analysis/request-regex-fuzz.test.ts`. It lists no pattern, and since review 3 no file under `lib/impact-analysis/` either (the directory is read from disk); add a file to `FUZZED_FILES_ELSEWHERE` when a change makes a file outside it read request text. A `new RegExp` it cannot evaluate statically fails unless listed in `RUNTIME_BUILT_PATTERNS` with what it is built from.
- It runs each pattern as a global `replace`, the most work any use of it can do, so it also flags a pattern only ever applied to a short string. Fix those too (trim first, or cut by index) rather than exempting them; all three found so far had an index-based equivalent, proved equal to the old pattern by a seeded sweep.
- The shape to look for is `X\s*$` or two adjacent optional runs: linear when it matches, quadratic on `X` + a long run + one other character.
- The gate's invariant is now monotone ("in a covered request the model cannot produce a core column by any answer") and asserted as a product over tables, types, column names, justifications, declared writers and request variants in `column-proposal-gate.test.ts`. A new field in the proposer's answer goes into that product in the same change.
- A rule that reads intent out of prose (a "record" cue, a "settings" cue deciding core) is one ordinary sentence away from the outcome it guards. Prefer a rule whose trigger the model and the incidental wording cannot reach, and accept the stated cost.

Links: [[project_deterministic-gate-over-llm-output-probes]], [[project_impact-offline-replay-and-pinned-shapes]].
