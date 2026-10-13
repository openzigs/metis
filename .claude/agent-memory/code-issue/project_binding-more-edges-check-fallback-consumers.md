---
name: binding-more-edges-check-fallback-consumers
description: When ingest starts binding edges a name-based fallback used to bind, every consumer that treated fallback-bound edges specially changes behaviour silently; diff the replay's tables line and compare per-seed crossToSchema on a pre-upgrade clone.
metadata:
  type: project
---

When ingest starts binding edges that a name-based fallback used to bind, check every consumer that treats fallback-bound edges specially. For #1071, `server/src/lib/impact-analysis/schema-impact.ts` gave inferred Go calls writes-only treatment (#791: a symbol reached only through one contributes what it WRITES, not what it reads). Making those calls real edges silently grew impact's affected tables while every file-level score stayed identical: edit precision and recall, blast recall and the six-issue table did not move by one file, and the only visible change was the `tables:` line of the replay.

**Why:** the fallback's "inferred" flag was doing two jobs. It marked weak evidence, and it was the only thing that told the schema walk "this is a handler reaching into storage". Once ingest binds the call exactly, the first meaning is gone and the second is still needed, so the flag has to be re-derived from something else. The first attempt keyed it on the new binding kind (`goResolution: "receiver-type"`), which was wrong in the other direction: it also flagged a storage method calling its own same-file helper, an edge that was a full edge before, and three seeds lost tables.

**How to apply:**

- Before the change, list the consumers of the fallback (`grep` for the loader, here `loadResolvedGoCalls` / `goCallsFrom`) and what each does differently for a fallback-bound edge.
- Measure on a pre-upgrade `cp -c` clone against the upgraded one, with the real code: every non-test function as a single seed through `crossToSchema` over `PrismaSchemaImpactDataSource`, and count seeds unchanged / gaining / losing tables. A policy is acceptable when no seed loses.
- Diff the replay's `tables:` line per issue, not only the precision and recall totals.
- The rule shipped for #1071 is `receiverCallCrossesLayer`: a receiver-type edge is writes-only unless caller and callee are in the same FILE (0 seeds lose, 21 gain on Miniflux v2.3.3). Same package also loses nothing and gains 7 more seeds; it was measured and not taken.
