# 0010 — The Finding provenance invariant is a CI ratchet, not a runtime parse

- **Status**: Accepted
- **Date**: 2026-08-28
- **Issue**: [#1325](https://github.com/openzigs/metis-private/issues/1325)
- **Supersedes the enforcement claims in**: `server/prisma/schema.prisma`,
  `docs/data-model.md` (both corrected by #1303/#1323 and again here)

## Context

Epic #298 gave every `Finding` row a `derivation` + `confidence` pair with one
invariant:

> `derivation === 'extracted'` ⇒ `confidence === 1.0`

Extraction is ground truth pulled straight from source or AST, so it cannot
carry a probability. `derivation` is additionally not model-assertable (#1234):
a model that emits `extracted` is coerced to `inferred`.

The invariant was documented in three places as being enforced. None of the
three was true:

1. `server/prisma/schema.prisma` cited "the Zod layer in
   `server/src/lib/findings/schema.ts`". That module had zero importers and was
   deleted in #1303.
2. `docs/data-model.md` cited a refinement on `createFindingSchema`
   (`packages/shared/src/analysis.ts`). That refinement exists, but the schema
   has **no runtime importer anywhere** — the only hits in `server/src` are
   prose in comments.
3. `docs/data-model.md` also claimed a **"type-safety gate"**: that
   `derivation` and `confidence` are non-nullable "specifically so TypeScript
   will refuse to compile a call that omits them".

Claim 3 was measured on this branch and is false. Both columns carry a Prisma
`@default(...)`, which makes them **optional** in the generated
`FindingCreateInput`. A create omitting both compiles clean:

```ts
export const omitsBoth: Prisma.FindingCreateInput = {
  category: "security", title: "t", body: "b",
  agentResult: { connect: { id: "ar-1" } },
};
```

`tsc --noEmit` reports nothing for it. (Verified with a control arm — a
deliberate `const bad: number = "nope"` in the same file *was* reported, so the
compiler had definitely loaded the file.)

So the invariant held for one reason only: both known writers happened to be
written to uphold it. `analysis-service.ts` routes through
`resolveFindingProvenance`, which cannot return `extracted`; `code-graph/ingest.ts`
hard-codes the pair.

## The decisive evidence

#1325 offered three options and named the risk as a *hypothetical* third writer
— "a bulk import, scan-finding materialisation, an admin backfill".

**The third writer already existed.** `materializeTriagedFinding`
(`server/src/lib/scanner/prisma-adapter.ts:1018`) has shipped since Epic #708.
It writes `projectId`, `description`, `source`, `metadata` and `createdById` —
five columns `Finding` does not have — and omits the required `agentResultId`
and `body`. It has never persisted a row; approved triage 500s and rolls the
triage stamp back with it. Filed as **#1330**.

It escaped three guards at once: the delegate is reached through
`(tx as unknown as { finding?: FindingDelegate }).finding` with a
`data: Record<string, unknown>`, so `tsc` checks nothing; the test mocks the
whole transaction client with a `vi.fn()` that accepts any payload; and a
`if (!findingDelegate) return { findingId: undefined }` fail-open reports success
when the delegate is missing.

This settles the choice between the three options empirically rather than by
taste.

## Decision

**Option 2 — a CI ratchet over every `Finding` write call site.**
`server/tests/finding-provenance-ratchet.test.ts`.

`createFindingSchema` stays a **type-only artefact** and now says so in its own
doc comment. It is not wired into any write path.

## Consequences

### Why not option 1 (call `createFindingSchema` from the writers)

It would not have caught the only writer that ever broke. A validation call
protects the call sites that opt in; the failure mode is a writer that does not.
Wiring `parse()` into `analysis-service.ts` and `ingest.ts` would have added a
Zod parse per finding to the two writers that were **already correct** and left
`materializeTriagedFinding` exactly as broken. Option 1 buys runtime cost
proportional to finding volume in exchange for coverage of the population that
was never at risk.

It also cannot express the failure that actually happened. `createFindingSchema`
takes an already-built object; the #1330 payload would have failed on
`agentResultId` and `body` long before the provenance refinement ran, so even a
wired schema would have reported the wrong defect.

### Why not option 3 (declare it structural and close)

"Writers uphold it by construction" was a true statement about two writers and a
false statement about three. The property is not structural; it is a
coincidence that has already lapsed once undetected.

### What the ratchet gives up

It is a static read of call sites, so it cannot see a `derivation` computed at
runtime. That case is handled by classification rather than by ignoring it: an
expression-valued `derivation` must be registered in `GUARDED_FINDING_WRITERS`
naming its guard, and the guard's behaviour is asserted separately — the test
proves `resolveFindingProvenance` never returns `extracted` for any input,
including malformed ones. A registry entry alone is not a waiver, and it waives
exactly one named site rather than a file (see *Waiver granularity* below).

It also cannot police a writer outside `server/src`, `server/scripts` and
`server/prisma`, or one that builds its payload in a helper and passes it by
reference. The second case is classified `unclassified` and fails, rather than
passing quietly.

### Fail-closed design

This repository has shipped fifteen gates that could not fail (#1215 found eight
in one audit; #1249/#1270/#1277 added more). Four properties address the shapes
that recur:

- **An empty call-site list is red, not clean.** Corpus floors, a named canary
  set of the five files known to contain writers, and a check that every
  `SCAN_ROOTS` entry contributed files are asserted *before* the headline check.
  Blinding the delegate detector produces 30 failures; the call-site floor sits
  *at* the measured count of 7, not below it, so deleting any one site is red.
- **The check is not derived from the list it validates** (#1249). Sites come
  from a TypeScript AST walk of the real tree; the registries only record
  waivers, and every registry entry must match a live call site of its declared
  kind or the test fails. Both entries were proven non-deletable.
- **Detection is by AST, not text.** A `.finding.create` grep is blind to the
  #1330 shape, where the delegate is captured in a local first. The walk follows
  the alias.
- **`prisma.scanFinding`** is a different model and must not be swept in; the
  property name is compared exactly and a dedicated assertion guards it.

### Waiver granularity — the shape found in review

The first cut of this gate keyed a call site on `file :: receiver.method`. That
key is shared by every same-shaped write in a file, and the registry checks
matched on the key alone, so **one entry waived every same-shaped write in that
file** — a new unguarded writer appended to `analysis-service.ts`, or a second
`findingDelegate.create` in `prisma-adapter.ts`, both passed with 33/33 green.
That is precisely the "third writer inherits no guard" risk #1325 was filed
about, in the two files most likely to grow one, and it falsified the claim
above that a registry entry is not a rubber stamp.

It is a distinct fail-open shape from the eight catalogued in #1215: the gate
enumerated call sites correctly from the AST and refused stale entries, and was
still fail-open, because the *waiver key* was coarser than the thing waived.
Only `guarded` and `defaulted` were affected — the two kinds that are safe only
because a human reviewed that one site. Literal violations were always red.

Two changes close it, and both are needed:

- **The site key carries the enclosing declaration** (`file :: enclosing ::
  receiver.method`), so writers in different functions cannot share an entry.
  Line numbers are deliberately *not* in the key: they move under every edit
  above the call and the registry would churn without gaining safety.
- **Each entry declares a `count`**, and the live count of matching sites must
  equal it exactly. This separates two writers in the *same* function, which no
  line-free key can, and it is checked in both directions — fewer is a stale
  waiver, more is an inherited one.

`registryDrift` is pure over its site list so both directions are unit-tested
directly, rather than only reachable by committing a violation.

### Delegate shapes the detector must not miss

The sweep resolves the delegate through four shapes: `prisma.finding`,
`prisma["finding"]`, a local `const d = prisma.finding`, and a destructured
`const { finding } = prisma` (renamed or not). The last three are evasion-shaped
rather than accident-shaped, but they cost four lines to cover and each has a
unit test. Aliases are tracked file-scoped rather than block-scoped, which can
over-match a same-named parameter elsewhere in the file; that direction is
deliberate, because an over-match is a red the author resolves and an
under-match is a writer that escapes.

### Follow-on obligations

- `DEFAULTED_FINDING_WRITERS` carries exactly one entry, for the broken
  `materializeTriagedFinding`. **It must be deleted when #1330 lands**, and the
  fixed writer must pass `derivation` and `confidence` explicitly. The
  shrink-only arm makes leaving it behind a test failure.
- Any future `Finding` writer passes a literal `derivation`, and `confidence: 1.0`
  literally whenever that value is `"extracted"`.
- A registry entry is never edited to *absorb* a new call site. Raising a `count`
  waives a writer nobody reviewed. Give the new writer its own entry, or make it
  pass a literal `derivation`.
