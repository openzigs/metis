---
name: recursion-audit-must-bound-work-not-depth
description: A recursion audit must bound WORK per call, not only depth; a depth cap with a `seen` set still allowed calls × embedded-fields blow-up. Find it with a generated lattice, timed as a scaling ratio.
metadata:
  type: project
---

A recursion audit must bound WORK per call, not only depth — a depth cap with a `seen` set still allowed calls × embedded-fields blow-up; find it with a generated K-types-per-level lattice and N calls, timed as a scaling ratio.

The first review of #1071 (PR #1104) found a stack overflow in the Go resolver; the fix threaded one depth counter through every re-entry and the audit stopped there. The second review found the same class open: `member()` in `server/src/lib/code-graph/go-type-resolution.ts` looked through every embedded field of every type on a level, called `resolveNamed` on each BEFORE its `seen` check, and kept nothing between calls. A generated 665 KB file (100 types a level, each embedding all 100 of the next, 3,000 calls) took the Go binding step of a real ingest from 0.47 s to 36.8 s; 2.1 MB was about ten minutes, on every ingest touching any Go file, uncancellable, with the error counter at 0.

**Why:** depth bounds the length of ONE path. Cost is paths × calls. A `seen` set bounds how many distinct nodes a traversal expands, not how many edges it inspects to find that out, and nothing bounds how often the traversal is repeated.

**How to apply:**

- For each traversal ask three questions, not one: how deep, how wide per level (edges inspected, not nodes kept), and how many times per input (per call, per file, per edge).
- Whatever depends only on the DECLARATIONS is worked out once and kept (here: what a type name means in a file, a type's struct, its whole member set, what an import path names, which declarations a viewer sees). A call then costs its own length.
- Kept answers must not depend on what was asked first: key by everything the answer depends on (the member set by package, type AND whether the viewer is a test file), and test both orders.
- Add budgets for what is left and COUNT them apart from errors (`GO_CALL_STEP_BUDGET`, `GO_TYPE_STEP_BUDGET`, `GO_BINDING_MAX_MS`); past a budget the answer is "undecided", never a guess, and the same whatever was resolved before.
- The fixture is a lattice generator (`goLattice` in `tests/lib/code-graph/go-resolver-bounded-work.test.ts`): K types a level each embedding all K of the next, N calls to a name nobody declares. Grow BOTH K² and N with the input size, or a quadratic cost looks linear.
- Assert the shape with `tests/helpers/linear-time.ts` (time at N over time at N/4), never a wall-clock bound.
- Prove the memoised code equals the old one on a real tree before changing any rule: 21,100 stored Go edges of Miniflux were byte-identical.
