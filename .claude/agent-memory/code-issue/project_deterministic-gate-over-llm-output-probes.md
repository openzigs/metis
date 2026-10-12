---
name: deterministic-gate-over-llm-output-probes
description: Two probes a "deterministic gate" over LLM output needs beyond its verbatim fixture, and the timing check any new regex on request text needs.
metadata:
  type: project
---

a 'deterministic gate' over LLM output in this project should be probed with (a) the model's own structured answer as an adversarial input and (b) one incidental cue word added to a context section of the verbatim fixture — both broke #791's gate while every verbatim-fixture test stayed green; and any new regex applied to request text needs a timing check on a 100 KB+ whitespace-free token, since text is accepted up to 500,000 characters.

**Why:** PR #1090's first cut of `column-proposal-gate.ts` passed 758 tests on the verbatim run-7 #4478 text and still had two blocking defects, both found by review and neither by the adversarial panel. A covering writer the proposer DECLARED on the proposal's own table made `users` a "covered" table, so the model's answer could move `users.mark_read_delay` into core. And `/\b\S+\s+(units)\s+(old|ago)\b/i` took 14 s on 160 KB of `a.a.a.`. A third, medium: "I lose track of what I have read" in a problem statement flipped the column to core, because the cue was read from the whole body.

**How to apply:**

- For (a), sweep the answer's fields as a product, not one at a time: types × justification × `coveredBy` × declared-id sets (unknown ids, ids on the proposal's own table, duplicates), and assert the invariant directly — here, `core(answer)` is a subset of `core(answer without its declarations)`. `column-proposal-gate.test.ts` has the shape.
- For (b), insert the cue into each section class the parser has (`context`, rejected alternatives, a non-imperative sub-aspect) and assert no change; then put the same sentence where it SHOULD count and assert the change, or the scoping test passes when the cue is simply dead.
- For the regex: best-of-three under 100 ms on 200 KB, over more than one shape — a dotted token, a URL, minified JSON, a run of `[`, a run of `?` in a heading, spaces only. A bounded quantifier is still slow when the bound is large: `[^\]]{1,300}` on 400 KB of `[` cost 185 ms until the class also excluded `[`.
- An engine-level copy of each gate probe is not redundant: the mutant "declared writers shield tables" survived the engine suite until a test built a real `users` writer through the lineage lookup.

Links: [[impact-offline-replay-and-pinned-shapes]], [[project_speckit-regex-negatives-pass-incidentally]].
