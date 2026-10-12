---
name: A counter of retained entries only sees the structures it was written for
description: After bounding one cache, audit EVERY Map/Set in memoised functions, probe retained heap with every type form over one wide declaration, and keep a heap watchdog at the caller
type: project
---

A counter of retained entries only sees the structures it was written for. Any Map or Set
built inside a memoised per-type or per-file function can still be a per-type copy. Probe
retained heap with every type FORM over one wide declaration (struct embedding, defined type,
alias, interface embedding), not just the form the last fix addressed; and keep a heap
watchdog at the caller as the last resort.

**Why.** PR #1104 (#1071), review cycle 5 (review 5495781122). Cycle 4 replaced a flattened
member table per type with layers of references and pinned it with `GoResolver.retained()`,
an exact entry counter. The suite was green and the cycle-4 probes (N types EMBEDDING a
3,000-field struct) were fixed. The reviewer then wrote `type Ti W` — a DEFINED type over the
same struct: `structAt` followed the definition to W and built a fresh `byName` Map of W's
fields for each Ti. 111 KB per type, 2,662 MB at 24,000 types (1.07 MB of Go), a heap abort
at 48,000 — and `retained()` read 48,000 entries, because it summed four named structures and
that Map was not one of them. It was the second fix in a row that addressed the reported
form and missed the next.

The audit of every cache then found a third shape nobody had reported, which the counter DID
see and nothing bounded: a defined type's allowance was `16 × members`, where "members" were
the fields of the struct it is defined OVER. N one-line types over a struct embedding 200
others each kept 200 layer references and a 3,000-name index: 375 KB per type, an abort at
about 10,000 types (0.5 MB of Go). A bound stated in terms of "what the type declares" must
count what its own source text says, or it is not a bound in source size.

**How to apply.**

1. Do not fix the instance. List every `new Map` / `new Set` / array that outlives a call,
   and for each write: keyed by what, holds what, bounded by what in terms of SOURCE SIZE.
   Anything that is a product of two source-sized quantities is shared or capped. In
   `go-type-resolution.ts` that table is the doc comment on `GO_RESOLVER_CACHES`.
2. Share by DECLARATION, not by asker: one `StructInfo` per struct declaration (a
   `Map<Decl, …>`), referenced by the type, by every `type A B` over it and by every viewer.
3. Make the counter structural: every cache is created through one helper (`keptMap`,
   `keptSet`, `keep`) that counts under a named cache, and a test greps the source for a
   bare `new Map(` / `new Set(` not marked `// transient:` / `// counted:` / `// constant:`.
   Give the helper ONE closure per cache, not one per map (that was +10% heap by itself).
4. Then check the counter against the HEAP, per form: retained bytes after a forced GC
   divided by counted entries stays under a fixed figure (150 to 250 B measured, asserted
   under 800). `tests/helpers/force-gc.ts` gets a real `gc()` inside a vitest fork
   (`v8.setFlagsFromString("--expose-gc")` + `vm.runInNewContext("gc")`).
5. Enumerate the forms and measure each: `tests/helpers/go-wide-shapes.ts` (struct embedding,
   defined, alias, pointer to defined, generic instantiation, interface embedding, defined
   over an interface, diamond, alias chain, generic types, the `_test.go` view, a defined
   type over a wide EMBEDDER). The test-file view doubles any per-type cache keyed by view.
6. Keep a watchdog OUTSIDE the accounting: `ingest.ts` samples `heapUsed` every 256 calls and
   stops the step like the time ceiling (`stopReason: "memory"`, resolver released). It is
   order-dependent on purpose; inject the reader in tests, and for the one real probe pass a
   reader that forces a GC first, or the sample measures garbage.
7. Probes run one per child `node --expose-gc` under `timeout`, at 2,000 / 6,000 / 24,000 /
   48,000: the before-figure is an abort, and only the largest size shows it.
