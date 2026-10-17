---
name: metis-marker-matchers-grep-exact-strings
description: A METIS marker whitespace-variant fix must grep every exact-string match of each metis: marker it touches; the shared matcher in packages/shared/src/metis-markers.ts is the one definition.
metadata:
  type: project
---

METIS writes HTML-comment markers into requirement bodies (`<!-- metis:clarifications:start -->`,
`:end -->`, `<!-- metis:criteria-predate-answers -->`). The one definition of what counts as a
marker is the shared whitespace-tolerant pattern in `packages/shared/src/metis-markers.ts`
(`findMetisMarkers` / `stripMetisMarkers`): it treats `<!--metis:x-->` as the same marker.

Any exact-string check (`text.includes(MARKER)`, `===`) disagrees with it. On #1225 the
clarification block's start/end markers were made whitespace-tolerant, but
`server/src/lib/analysis/clarification-criteria-flag.ts` still matched the criteria flag as an
exact string. A retyped flag marker with unchanged answers then read as "answers changed" and
wrote a requirement version nobody could see (the same bug the PR was fixing, one marker over).
Review caught it, not the tests.

**Why:** a whitespace-variant fix is applied where the bug was reported, and the other markers on
the same path are matched somewhere else.

**How to apply:**

- When a fix touches one `metis:` marker, `grep -rn "metis:" server/src ui/src packages/shared/src`
  and list every exact-string match of each marker on the path, not just the reported one.
- Detect and clear with `findMetisMarkers` (filter on `name`); never hand-roll a second regex.
- Comparing a stored block with a rendered one: canonicalise every marker first, then compare.
- Test each marker's variant with a byte-exact no-op assertion (LF and CRLF).
- After #1225 the clarification path (enrichment, criteria flag, requirement version service) no
  longer exact-matches. Spec-kit's `<!-- metis: generated from plan.md vN -->` stamp
  (`server/src/lib/spec-kit/plan-provenance.ts`, `ui/src/lib/spec-kit-display.ts`) is a separate
  marker the shared pattern does not match (space after the colon) and is still exact.
