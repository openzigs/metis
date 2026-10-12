---
name: A before-the-change fixture pins only what its scenario reaches
description: On an "off is byte-identical" claim, regenerate the fixture on the base and mutate each off-path line the diff touched
type: project
---

A before-the-change fixture test only pins the off path as far as its scenario reaches. On
any "off is byte-identical" claim, regenerate the fixture on the current base, then mutate
each off-path line the diff touched and check which ones the fixture actually kills.

**Why.** #1113 (BRD topic plan, `DOCS_GEN_TOPIC_PLAN`, off by default) proved "off is main"
with `holistic-synthesizer-topic-plan-off.test.ts` against `brd-before-1070.json`, written
by the code before the change. Its model cited nothing and the run had no claim extractor
and no escalation, so every off-path line the diff touched inside the grounding and
escalation code was pinned by reading alone. Two things got through that the reviewer
found by hand (review 5493649115, follow-ups in #1119):

- a real off-path difference: `citation-footnotes.ts` matched the prefix `facts:canon:`,
  which is also the legacy facts id of a top-level module directory named `canon`, so its
  footnote changed whatever the setting;
- a surviving mutant: `documentMaxChars` for `bodyMaxChars` in the unplanned document fit
  (footnote definitions were 0 characters in the fixture, so the two were equal).

**How to apply.**

1. Produce the fixture from the base, not from your branch: `git archive <base-sha>` into a
   scratch directory, copy only the test file in, install, build `@metis/shared`, run the
   test with its fixture-writing switch, copy the JSON back. The test must import nothing
   the change adds. Run the writer twice and compare hashes: a fixture that is not
   deterministic pins nothing.
2. List the off-path lines from `git diff <base> <head> -- <dir>`: every changed line that
   still runs with the setting off, including lines that were only moved or re-indented.
3. Mutate each one, one at a time, and run the fixture test. Record killed or survived in
   a table in the PR.
4. For each survivor decide which it is, and say so plainly:
   - the scenario does not reach it: extend the scenario (citations, a claim extractor, an
     escalation, a table, an H4, a module with an awkward name) and regenerate;
   - it is dead on the off path (a value only the on path reads): no fixture can kill it;
   - the mutant is equivalent by construction (an identity when a list is empty).
5. Put the awkward input in the scenario itself. Naming one fixture module `canon` is what
   made the footnote difference visible to the fixture at all.

Hash the judge and claim-extractor requests (messages and options) into the fixture, not
only the section prompts: the grounding a section is judged against is otherwise invisible.
