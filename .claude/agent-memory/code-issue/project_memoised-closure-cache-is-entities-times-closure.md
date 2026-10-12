---
name: A per-entity cache whose value is a flattened closure is entities × closure in memory
description: Bounding and testing time says nothing about what memoised tables retain; probe heap across two input sizes through the real parser, because a heap abort is uncatchable
type: project
---

Every review round of the Go resolver bounded and tested time and none measured what the
memoised tables retain. A per-entity cache whose value is a flattened closure (member tables
per type, name sets per interface) is entities × closure in memory; probe heap across two
input sizes through the real parser, not only elapsed time. A heap abort is uncatchable and
sits inside every step budget.

**Why.** PR #1104 (#1071), review cycle 4 (review 5494760450). Cycle 3 fixed "calls × fields"
time by memoising, per type, a table of every member the type has (own and promoted), and per
interface a set of every name below it. Both were linear in TIME and pinned by ratio tests.
The reviewer then built N types embedding one 3,000-field struct: 2,000 types (131 KB)
732 MB, 6,000 types 2,160 MB, 24,000 types (1.3 MB) `JavaScript heap out of memory` at about
4 GB — with `overBudget` and `skipped` both 0, because the per-call budget, the per-type
budget and the 30 s ceiling all count steps or milliseconds. A chain of 8,000 embedded
interfaces was 22.7 s and 3.3 GB. Nothing an ingest wraps in `try` sees a heap abort: it takes
the server down on every ingest of that repository, scheduled refresh included.

**How to apply.**

1. When a fix is "work it out once per X and keep it", write down the SIZE of what is kept
   per X before writing the cache. If the value is a closure (everything X reaches), the
   cache is X-count × closure. Keep references to what X reaches directly and answer by
   walking them; memoise per question asked, not per X.
2. Every cache needs a bound that is a property of the entity alone (never "full after N
   entries": that makes verdicts depend on call order, and a resumed ingest sees a different
   order). In `go-type-resolution.ts` that is `GO_TYPE_LAYER_BUDGET` and
   `GO_TYPE_RETAINED_PER_MEMBER`; past it the type is `unknown`, `why: "budget"`.
3. Expose the retained ENTRY count (`GoResolver.retained()`) and assert it exactly at two
   sizes; add a heap-growth bound several times under the old figure and a time ratio via
   `server/tests/helpers/linear-time.ts`. An entry counter is deterministic; `heapUsed`
   without `--expose-gc` is not, so it is only the coarse check.
4. Scale BOTH factors of the product in the scaling test. N types over a fixed 3,000-field
   struct is linear in N at any representation; types and fields growing together is what
   shows 16× at 4× the input.
5. When two lookup routes exist for one question (walk the layers / use a name index), run
   the whole oracle corpus through each, forced, and compare verdict lists. That test found
   a real divergence within a minute of being written (an option shared by the interface cap
   and the layer budget).
6. Measure probes in a child `node --expose-gc` under `timeout`, never inside the vitest
   worker: the before-figure IS a heap abort.
