# 0011 — A materialised scan finding's provenance is `scanFindingId`, not a synthetic `AgentResult`

- **Status**: Accepted
- **Date**: 2026-08-28
- **Issue**: [#1330](https://github.com/openzigs/metis-private/issues/1330)
- **Follows**: [0010 — The Finding provenance invariant is a CI ratchet](0010-finding-provenance-invariant-is-a-ci-ratchet.md)

## Context

Epic #708 / #714 gave the AI bug scanner a triage workflow: a reviewer approves
a `ScanFinding` and it is promoted ("materialised") into a first-class `Finding`
row, so scanner output joins analysis output in one table.

The write never worked. `materializeTriagedFinding`
(`server/src/lib/scanner/prisma-adapter.ts`) built a `finding.create` payload
naming five columns `Finding` does not have (`projectId`, `description`,
`source`, `metadata`, `createdById`) while omitting the required `body`. Against
a real client it raises `Argument \`body\` is missing`. Because the throw lands
inside the transaction *after* `scanFinding.update` has stamped the triage, the
rollback destroyed the reviewer's decision as well — so an approval was not
merely un-materialised, it was un-recorded. `POST
/projects/:projectId/scans/:scanId/findings/:findingId/triage` with
`decision: "approved"` has never succeeded, for eight months.

Fixing the payload forces a schema decision, because `Finding.agentResultId`
was `String` — required, no default — and a scan finding has no `AgentResult`.
The scanner is not an analysis agent: it has no `Analysis`, no agent run, no
`agentKey` from `ANALYSIS_AGENT_KEYS`.

## Decision

**Make `Finding.agentResultId` nullable and use the existing `scanFindingId`
back-relation as the provenance of a materialised row.** Exactly one of the two
is set on any `Finding`: analysis-pipeline rows set `agentResultId` and never
`scanFindingId`; materialised scan findings do the reverse.

The rejected alternative was to **synthesise a per-scan `AgentResult`** with
`agentKey: "ai_bug_scanner"` and hang materialised findings off it. It is
cheaper — no migration — and it is wrong for three concrete reasons:

1. **It fabricates a run that never happened.** `AgentResult` carries
   `startedAt`, `completedAt`, `status`, `output` and the token counters for an
   analysis agent execution. A synthetic row has to invent all of them, and
   every one of those values would be a lie of the kind ADR 0010 exists to stop
   the codebase telling itself.
2. **It pollutes every consumer that reasons over `AgentResult`.** They are not
   hypothetical: `getAnalysisSnapshot` walks `analysis.agentResults`,
   `toSnapshot` filters on `SAFE_AGENT_KEYS`, `promote-requirements` and
   `orchestrator` query the model directly, and the token/cost rollups sum over
   it. A synthetic row would need an `analysisId` too — so it would also have to
   fabricate an `Analysis`.
3. **`scanFindingId` already exists for exactly this.** Epic #708 added
   `Finding.scanFindingId String? @unique` with the schema comment "back-link to
   the ScanFinding this row was materialised from on triage-approval", plus the
   `@relation("MaterializedScanFinding")` pair. No code had ever written it. The
   column was not missing; the writer was.

The nullable FK ripples into exactly two readers, and both resolve honestly
rather than by cast:

- `toSnapshot` reads findings through `agentResults.findings`, so the FK is the
  enclosing row's id by construction (`f.agentResultId ?? a.id`). The public
  `AnalysisSnapshot` contract stays `string`, so the UI's `DerivationBadge` is
  untouched.
- `getFindingForPublish` now returns `null` when `agentResult` is absent. That
  is a deliberate scope statement: a materialised scan finding is **not**
  publishable through the analysis path, which needs an analysis, a project name
  and an agent key it does not have. The scanner has its own publish route.

## Why the three defeated guards are also part of this decision

The payload bug is one line of consequence; that it survived three guards is the
durable finding. Each is fixed at the mechanism, not the symptom.

1. **The cast erased the generated types.** The delegate was reached via
   `(tx as unknown as { finding?: FindingDelegate }).finding` with a
   hand-written `data: Record<string, unknown>`.

   Removing the cast is **not sufficient, and this was measured on this
   branch**: `tx.finding.create` is generic
   (`create<T extends FindingCreateArgs>(args: SelectSubset<T, FindingCreateArgs>)`),
   so `data` is contextually typed by `T["data"]` — inferred from the literal
   itself — and an inline literal gets **no excess-property check at all**. With
   the cast gone and real types in place, `projectId: …` and even a nonsense
   `title2: …` both compiled clean. Only a *missing required* key was caught.

   The fix is `} satisfies Prisma.FindingUncheckedCreateInput` on the inline
   literal, which re-freshens it against a concrete type (an unknown column is
   TS2353, a missing required one TS1360 — both mutation-measured). `satisfies` rather
   than a hoisted annotated `const` because the #1325 ratchet must still see an
   inline object literal to classify the site — an annotated local type-checks
   identically but makes the site `unclassified`, permanently red.

2. **The test asserted against its own fake.**
   `finding: { create: vi.fn().mockResolvedValue({ id: "find-1" }) }` with
   `expect(tx.finding.create).toHaveBeenCalledTimes(1)` is satisfied by any
   payload whatsoever. Replaced by `server/tests/lib/db/prisma-model-schema.ts`,
   a fake whose allowed and required keys are **parsed from
   `server/prisma/schema.prisma` at test time**, plus
   `src/lib/scanner/materialize-triaged-finding.roundtrip.test.ts`, which runs
   the real function against a real SQLite database built by
   `prisma migrate deploy` and **reads the row back** through a fresh query.

3. **A missing dependency read as success.**
   `if (!findingDelegate) return { findingId: undefined };` made the route answer
   `200 {success: true, materializedFindingId: null}`, indistinguishable from a
   rejected triage. The delegate is now reached directly (it cannot be absent),
   and the remaining absence — an approval arriving with no
   `MaterialisedFindingInput` — **throws before the transaction opens**, so the
   triage stamp is never written and rolled back.

## Consequences

- `findings.agentResultId` is nullable on both dialects. Four coordinated edits
  as this repo requires: `server/prisma/schema.prisma`, the regenerated
  `server/prisma/postgres/schema.prisma`, an incremental migration on each side,
  and the Postgres cumulative init baseline.
- The route now returns a real `materializedFindingId`, and the payload is
  `applyTriageDecision`'s own `MaterialisedFindingInput`, threaded through
  rather than rebuilt. **When a route recomputes what a service already
  returned, diff the two** — that duplication is what allowed two different
  payloads to exist.
- The #1325 ratchet's `DEFAULTED_FINDING_WRITERS` entry for this call site is
  deleted: the writer now passes `derivation` as a literal and classifies as
  `literal-safe`.
- **Not addressed here:** no backfill exists for scan findings approved between
  #714 and this fix. There is nothing to backfill — those approvals were rolled
  back, so the rows are still `pending`, and re-approving them now works.
