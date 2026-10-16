---
name: sync-roadmap-label-check-traps
description: Roadmap sync traps — main() tests hit the real write throttle, the "exactly one" label rule is backed only by a missing check (#1181), and whole-list replace writes need completed iterations in the fixture (#1205).
metadata:
  type: project
---

Two traps in `scripts/lib/sync-roadmap-core.mjs` and its tests, found on PR #1183 (#1181).

**1. `main()` in the sync tests uses the real throttle: about one second per write.** `main` builds
its own client with the real `sleep`. A `main` test whose fake board makes even five writes times
out at vitest's 5 s default. The first draft of the #1181 exit-code test did exactly this. Seed the
fake board with items that already hold every value, so nothing is written, and assert
`gh.mutations` is `[]`. Or test through the test file's own `run()` helper
(`scripts/lib/sync-roadmap-core.test.mjs`, around line 582; not an export of the core module),
which calls the exported `sync()` with a client built with `sleep: async () => {}`.

**2. An "exactly one X label" rule may be backed only by a missing-X check.** #1181's rule says
exactly one tier and exactly one `area:`. `missingLabels`/`labelGaps` report only *absence*: two
tier labels or two `area:` labels are not reported. The owner accepted that leniency, and
`docs/ops/roadmap-board.md` states it. Also, `blocked` is in `TIER_BY_LABEL`, so an issue's own
`blocked` label ends `resolveTier`'s walk as tier Blocked. A blocked issue with no `priority:` label
therefore passes the check. Tightening that needs a second walk that skips `blocked`. Do not
assume the report enforces the rule's "exactly one" or "blocked as well".

**How to apply:** before claiming a check enforces a filing rule, compare each quantifier in the
rule ("exactly one", "as well") with what the check actually tests.

## 3. Replace-the-whole-list writes (#1205, 2026-10-16)

`updateProjectV2Field` replaces a field's whole list, for single-select options and for
iterations alike. What keeps ids and item values is now written in the comments above
`UPDATE_FIELD` and `UPDATE_ITERATIONS` in `sync-roadmap-core.mjs` (every existing element goes
back with its `id`, completed iterations too), and the sync refuses an iteration write when an
existing iteration has no id. Read those comments; do not re-measure.

**Test it with every kind of existing element in the fixture.** #1205's `withCycles` helper
first left `completedIterations` empty, and a payload dropping them passed 83/83. The tests now
have `withCycles([c1], [c0])` cases; keep one for any new replace path, break the payload on
purpose before trusting it, and re-read the field before writing. More shapes like this:
[[test-falsifiability-traps]].
