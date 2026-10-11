---
name: project_weak-tested-by-relation-check-every-count
description: adding a weak/heuristic relation to "Tested by" needs every surface that counts links checked, not only the per-test label map
metadata:
  type: project
---

When a weak or heuristic relation is added to 'Tested by', check every surface that turns links into a count (listUntestedRequirements and its panel, the workspace rollup, the chat tool's 'Tested by' text), not only the per-test label map — the type system forces the label records to be exhaustive but nothing forces the aggregate counts to distinguish weak from strict.

**Why:** the label records are keyed by relation, so a new relation does not compile until each one names it. The aggregates only count links, so the compiler has nothing to say about whether a weak link should count the same as a strict one. This is a reviewer's finding (a reviewer has no store of its own), filed verbatim above at the dispatcher's request in the #1069 PR; it was not re-measured there.

**How to apply:** when adding a relation that is a guess (name-inferred, bare-name call resolution, lower confidence), search for every reader of the links, not for the relation type. Check at least the three surfaces named above. For each, decide whether a weak link counts, and either leave it out or report it as its own number. Add a test where a requirement has only a weak link and assert what each count says. Related: `project_go-call-resolver-binds-by-bare-name.md`.
