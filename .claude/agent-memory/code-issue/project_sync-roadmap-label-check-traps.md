---
name: sync-roadmap-label-check-traps
description: Two traps in the roadmap sync's label check (#1181) — main() tests hit the real write throttle, and the "exactly one" rule is backed only by a missing check.
metadata:
  type: project
---

Two traps in `scripts/lib/sync-roadmap-core.mjs` and its tests, found on PR #1183 (#1181).

**1. `main()` in the sync tests uses the real throttle: about one second per write.** `main` builds
its own client with the real `sleep`. A `main` test whose fake board makes even five writes times
out at vitest's 5 s default. The first draft of the #1181 exit-code test did exactly this. Seed the
fake board with items that already hold every value, so nothing is written, and assert
`gh.mutations` is `[]`. Or test through `run()`/`sync()`, which inject `sleep: async () => {}`.

**2. An "exactly one X label" rule may be backed only by a missing-X check.** #1181's rule says
exactly one tier and exactly one `area:`. `missingLabels`/`labelGaps` report only *absence*: two
tier labels or two `area:` labels are not reported. The owner accepted that leniency, and
`docs/ops/roadmap-board.md` states it. Also, `blocked` is in `TIER_BY_LABEL`, so an issue's own
`blocked` label ends `resolveTier`'s walk as tier Blocked. A blocked issue with no `priority:` label
therefore passes the check. Tightening that needs a second walk that skips `blocked`. Do not
assume the report enforces the rule's "exactly one" or "blocked as well".

**How to apply:** before claiming a check enforces a filing rule, compare each quantifier in the
rule ("exactly one", "as well") with what the check actually tests.
