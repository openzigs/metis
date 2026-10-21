---
name: A memory probe must vary what a type declares itself and how many tables one call builds
description: Varying only the width of the underlying or embedded declaration misses the dominant term; a count-based heap watchdog is only as good as the worst single call
type: project
---

In the Go resolver, a memory probe that varies only the WIDTH of the underlying or embedded
declaration misses the term that dominates: the allowance a type earns from the members it
declares ITSELF, multiplied by the number of tables ONE call builds. And a heap watchdog
that samples by call count is only as good as the worst single call. Before trusting a
table of retained memory, probe two more shapes: "N types × K cheap own fields" and "one
call selecting through H wide types".

**Why.** PR #1104 (#1071), review cycle 6 (review 5496595198). Cycle 5 had probed twelve
shapes, every one of them N types over ONE wide declaration, and reported 9 to 68 MB. None
reached the name index, because what earned a type its index was `16 × its own member
count` — and fields are cheap to write:

- `type Ti struct{ W; a0 … a7 int }` over a `W` embedding 133 structs kept a 143-name index
  per type: 560 MB at 24,000 types from 2.1 MB of Go, 1,091 MB with test-file callers (a
  second view of each type), 2,333 MB with forty fields. About 150 B a name, per type.
- `struct{ W; a0 … a1999 int; N *T }` earned a 32,000-name index (5 MB a table), and one
  call `t.N.N.N.N.N.F()` builds six tables. The watchdog read the heap every 256 calls;
  160 such calls ended the process at call 144, before its second reading.

The bound "linear in the source" was true and useless: the constant was 285 B retained per
source byte, and the per-call figure the sampling interval had been sized from (111 KB)
was 200 times too small.

**How to apply.**

- A per-type allowance proportional to something the author writes cheaply needs an
  ABSOLUTE cap as well. State the worst single call in a comment as cap × the longest chain,
  and pin it with a test that builds exactly that call.
- Tune the probe to the allowance, not to a round number: the worst input sits exactly AT
  the cap (here 62 embedded structs, 64 layer types). Report the tuned shape, not only the
  reviewer's parameters — a cap of 128 passed the reviewer's exact trees and still retained
  443 MB re-tuned.
- Sample a watchdog on GROWTH (a running entry count the resolver already keeps, one
  comparison a call) as well as on call count. Reading the heap every call was 3× the whole
  resolving step on Miniflux; the growth rule cost nothing measurable.
- Measure real code before choosing the cap: the widest member table in Miniflux listed 8
  layer types and in about 4,200 files of Go's own source 4, so the name index had never
  been reached by anything real and capping at the layer budget cost no measured recall.
- A test of such a watchdog must make FEWER calls than the count interval, or it passes on
  the count rule alone.

See also `project_retained-counter-sees-only-what-it-was-written-for.md` (cycle 5) and
`project_memoised-closure-cache-is-entities-times-closure.md` (cycle 4). Both were retired
from the index on 2026-10-21 and are reached from here; files unchanged. In one line each:
cycle 4 — a per-entity cache of a flattened closure is entities × closure, so probe heap at
two sizes in a child `node --expose-gc`; cycle 5 — a retained-entry counter only sees the
structures it was written for, so audit every `Map`/`Set` (`GO_RESOLVER_CACHES` in
`server/src/lib/code-graph/go-type-resolution.ts`) and probe every type form.

**Heap-delta baselines (#1307).** V8's usual 6-GC settle is not enough for a heap-delta test baseline: some memory is freed only after more than 6 full GCs (`--always-osr` reproduces it: 10 of 48 runs dropped with 6 GCs, 0 of 48 with 10). Settle with more GCs, and keep every pre-baseline input reachable until the final reading.
