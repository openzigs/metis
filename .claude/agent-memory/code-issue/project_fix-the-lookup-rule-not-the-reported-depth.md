---
name: A wrong-binding fix scoped to the reported depth leaves the same guess bound one level away
description: Bind a Go import by Go's own lookup rule, never by a patched heuristic, and check by moving the corpus fixture directory up or down a level
type: project
---

When a heuristic binds a wrong target, do not fix the SHAPE that was reported — its depth,
its segment count, its position in the tree. Replace the heuristic with the rule the
language itself uses, and then test the neighbours of the reported case by moving the
fixture, not by thinking about it.

**Why.** PR #1104 (#1071), review cycles 5 to 7 (review 5497196908). In a tree with no
`go.mod`, "exactly one directory ends in the import path" bound a dependency's call to a
project function, and it was fixed three times:

- cycle 5: a two-segment tail (`pkg/errors/` for `github.com/pkg/errors`) — fixed for
  proper tails;
- cycle 6: `internal/appengine/` for `import "appengine"` — fixed for ONE segment, BELOW
  the root;
- cycle 7: the same directory at the root (`appengine/`) still bound, and so did
  `internal/appengine/datastore/` for the two-segment `appengine/datastore`.

Each fix carried a clause for a depth or a segment count, and each clause was the boundary
of the next finding. The rule that ended it has none: a directory binds only where Go
would look — `<prefix>/src/P` with the importer under that `src`, `<prefix>/vendor/P` with
the importer under `<prefix>`, or `P` from the root when its first segment is a domain
(has a dot). One such directory binds, two are undecided, anything else holding the path
is undecided, nothing at all is external. A file inside a module never binds this way.

Even the corrected rule was wrong as first written ("directly under a `src`"): moving the
fixture to `src/appstats/` under the package root bound it for the dependency `appstats`,
and the type checker said external. Asking where the IMPORTER is closed it.

**How to apply.**

- For any binding decided by where a directory sits, run the displacement check: move each
  corpus fixture package one level up, one level down, and under a directory with a
  meaningful name (`src`, `vendor`), re-run
  `tests/lib/code-graph/go-oracle-corpus.test.ts -t SOUNDNESS --retry=0`, and move it back.
  A SOUNDNESS failure is a finding unless the type checker's answer would itself change
  with the move — the snapshot is for the unmoved tree, so say which it is.
- A rule with "when there is exactly one segment" or "below the root" in it is a patch.
  Write the rule so that every row of its test runs for a one-segment AND a multi-segment
  path, and for an importer inside and outside the scope.
- An answer that depends on where the importer is must not go into a cache keyed without
  it. Here the per-module import cache skips such answers; the per-file one keeps them.
- `vendor/` is in the default `.metisignore`, so the oracle views never see a vendored
  directory: the vendor clause is pinned by unit rows only.
- A `lastIndexOf`-driven walk over "every ancestor directory" must clamp -1 to 0 before
  slicing: `slice(0, -1)` is the path minus one character, so an importer in `srcs/` or
  `x/src2/` passed the whole-segment `src` check (cycle 8, review 5497656607). Put the
  lookalike directory on the IMPORTER side of a test row, not only on the target side.

See also `project_language-resolver-needs-a-type-checker-oracle.md` and
`project_decided-verdicts-need-positive-evidence.md`.
