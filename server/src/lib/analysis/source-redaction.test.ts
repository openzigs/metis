/**
 * #2447 — the redact-on-read decision and its placeholders, without a
 * database: every branch of `sourceGuardOf`, what `loadSourceGuard` reads (and
 * does not), and what a placeholder keeps. Each surface is checked over a real
 * database in `tests/source-redaction-2447.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RESTRICTED_SOURCE_BODY,
  RESTRICTED_SOURCE_TITLE,
  type AnalysisSnapshot,
  type CrossDocFinding,
} from "@metis/shared";
import { InactiveAclActorError, sharedAudienceActor, type AclActor } from "../rag/acl.js";

const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../audit/audit-service.js", () => ({ audit: auditSpy }));
import {
  documentCoverageRows,
  documentSourceRow,
  inputDocumentIds,
  loadSourceGuard,
  redactAnalysisSnapshot,
  restrictedRequirementIds,
  redactRunCapability,
  restrictedCrossDocFinding,
  restrictedFinding,
  restrictedIds,
  restrictedRequirement,
  sharedSourceReader,
  sourceGuardOf,
} from "./source-redaction.js";

const ALICE: AclActor = { userId: "alice", role: "analyst" };
const BOB: AclActor = { userId: "bob", role: "analyst" };
const ADMIN: AclActor = { userId: "root", role: "admin" };
const SHARED = sharedAudienceActor("system");

const ids = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });

const runs = new Map([
  ["shared-run", { projectId: "p1", sourceAccess: "shared" }],
  ["legacy-run", { projectId: "p1", sourceAccess: null }],
  ["other-run", { projectId: "p1", sourceAccess: "future" }],
]);
const documents = new Map([
  ["d-open", { projectId: "p1", subjects: [] }],
  ["d-alice", { projectId: "p1", subjects: [{ kind: "user" as const, value: "alice" }] }],
  ["d-analysts", { projectId: "p1", subjects: [{ kind: "role" as const, value: "analyst" }] }],
  ["d-elsewhere", { projectId: "p2", subjects: [] }],
]);
const guardFor = (actor: AclActor | null) => sourceGuardOf({ runs, documents, actor });

describe("sourceGuardOf (#2447)", () => {
  it("shows a row whose every source the reader can see", () => {
    const row = { analysisId: "shared-run", sourceIds: ids(["d-open", "d-alice"]) };
    expect(guardFor(ALICE).canSee(row)).toBe(true);
    expect(guardFor(BOB).canSee(row)).toBe(false);
    expect(guardFor(ADMIN).canSee(row)).toBe(true);
    expect(guardFor(SHARED).canSee(row)).toBe(false);
  });

  it("matches role subjects, and shows an empty list (a finding citing nothing)", () => {
    expect(guardFor(BOB).canSee({ analysisId: "shared-run", sourceIds: ids(["d-analysts"]) })).toBe(
      true,
    );
    expect(guardFor(SHARED).canSee({ analysisId: "shared-run", sourceIds: ids([]) })).toBe(true);
  });

  it("hides a row naming a document it cannot place: unknown, or in another project", () => {
    expect(guardFor(BOB).canSee({ analysisId: "shared-run", sourceIds: ids(["d-gone"]) })).toBe(
      false,
    );
    expect(
      guardFor(ADMIN).canSee({ analysisId: "shared-run", sourceIds: ids(["d-elsewhere"]) }),
    ).toBe(false);
  });

  it("an unresolved reader sees only unrestricted sources", () => {
    const guard = guardFor(null);
    expect(guard.canSee({ analysisId: "shared-run", sourceIds: ids(["d-open"]) })).toBe(true);
    expect(guard.canSee({ analysisId: "shared-run", sourceIds: ids(["d-alice"]) })).toBe(false);
  });

  it("keeps the shared-audience rule for a run from before #2446, whatever its rows hold", () => {
    const row = { analysisId: "legacy-run", sourceIds: ids(["d-alice"]) };
    expect(guardFor(BOB).canSee(row)).toBe(true);
    expect(guardFor(BOB).canSeeRun("legacy-run")).toBe(true);
  });

  it("fails closed on a row with no record: the run's audience decides", () => {
    // A shared run read as the shared audience: every member sees what it saw.
    expect(guardFor(SHARED).canSee({ analysisId: "shared-run", sourceIds: null })).toBe(true);
    expect(guardFor(BOB).canSeeRun("shared-run")).toBe(true);
    // Any other marker: only an admin, whom no list restricts.
    expect(guardFor(BOB).canSee({ analysisId: "other-run", sourceIds: null })).toBe(false);
    expect(guardFor(ALICE).canSeeRun("other-run")).toBe(false);
    expect(guardFor(ADMIN).canSee({ analysisId: "other-run", sourceIds: null })).toBe(true);
    expect(guardFor(null).canSeeRun("other-run")).toBe(false);
  });

  it("on a shared run, a row with no record needs every source the run recorded, as its lists are now", () => {
    // The run's rows cite d-alice, restricted (after the run) to Alice.
    const corpus = new Map([["shared-run", new Set(["d-open", "d-alice"])]]);
    const guard = (actor: AclActor | null) => sourceGuardOf({ runs, documents, actor, corpus });
    const row = { analysisId: "shared-run", sourceIds: null };
    expect(guard(BOB).canSee(row)).toBe(false);
    expect(guard(BOB).canSeeRun("shared-run")).toBe(false);
    expect(guard(SHARED).canSeeRun("shared-run")).toBe(false);
    expect(guard(null).canSeeRun("shared-run")).toBe(false);
    expect(guard(ALICE).canSee(row)).toBe(true);
    expect(guard(ADMIN).canSeeRun("shared-run")).toBe(true);
    // A row with its own record is still decided by that record alone.
    expect(guard(BOB).canSee({ analysisId: "shared-run", sourceIds: ids(["d-open"]) })).toBe(true);
    // A corpus of open documents only: every member.
    const open = sourceGuardOf({
      runs,
      documents,
      actor: BOB,
      corpus: new Map([["shared-run", new Set(["d-open"])]]),
    });
    expect(open.canSeeRun("shared-run")).toBe(true);
  });

  it("reads an unparseable record as no record, never as an empty one", () => {
    expect(guardFor(BOB).canSee({ analysisId: "other-run", sourceIds: "[]" })).toBe(false);
    expect(guardFor(BOB).canSee({ analysisId: "other-run", sourceIds: "{not json" })).toBe(false);
  });

  it("hides a row of a run it cannot find", () => {
    expect(guardFor(ADMIN).canSee({ analysisId: "gone", sourceIds: ids([]) })).toBe(false);
    expect(guardFor(ADMIN).canSeeRun("gone")).toBe(false);
  });
});

/** A fake of the reads the loader makes, counting them. */
function fakeDb(
  runRows: Array<{ id: string; projectId: string; sourceAccess: string | null }>,
  docRows: Array<{ id: string; projectId: string; aclSubjects: string }>,
  /** Each run's recorded rows, as the run-wide read finds them. */
  recorded: Array<{
    analysisId: string;
    sourceIds: string;
    /** Which row kind records it; a finding by default. */
    kind?: "finding" | "requirement" | "crossDoc";
  }> = [],
  /** The runs with a finding whose sources were not recorded (a failed read). */
  unrecorded: string[] = [],
  /** #2448 — each pass's read set (`AgentResult.readSourceIds`). */
  passes: Array<{ analysisId: string; readSourceIds: string | null }> = [],
) {
  type RunWhere = {
    analysisId?: { in: string[] };
    agentResult?: { analysisId: { in: string[] } };
    sourceIds?: null | { not: null };
  };
  const inRuns = (where: RunWhere, kind: "finding" | "requirement" | "crossDoc") =>
    recorded.filter(
      (r) =>
        (r.kind ?? "finding") === kind &&
        (where.analysisId?.in ?? where.agentResult?.analysisId.in ?? []).includes(r.analysisId),
    );
  const findingFindMany = vi.fn(async ({ where }: { where: RunWhere }) =>
    where.sourceIds === null
      ? unrecorded
          .filter((id) => where.agentResult!.analysisId.in.includes(id))
          .map((analysisId) => ({ agentResult: { analysisId } }))
      : inRuns(where, "finding").map((r) => ({
          sourceIds: r.sourceIds,
          agentResult: { analysisId: r.analysisId },
        })),
  );
  const requirementFindMany = vi.fn(async ({ where }: { where: RunWhere }) =>
    inRuns(where, "requirement"),
  );
  const crossDocFindMany = vi.fn(async ({ where }: { where: RunWhere }) =>
    inRuns(where, "crossDoc"),
  );
  const analysisFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    runRows.filter((r) => where.id.in.includes(r.id)),
  );
  const documentFindMany = vi.fn(
    async ({ where }: { where: { id?: { in: string[] }; projectId?: string } }) =>
      docRows.filter((d) =>
        where.projectId !== undefined
          ? d.projectId === where.projectId
          : where.id!.in.includes(d.id),
      ),
  );
  const agentResultFindMany = vi.fn(
    async ({ where }: { where: { analysisId: { in: string[] } } }) =>
      passes.filter((p) => where.analysisId.in.includes(p.analysisId)),
  );
  const db = {
    agentResult: { findMany: agentResultFindMany },
    analysis: { findMany: analysisFindMany },
    document: { findMany: documentFindMany },
    finding: { findMany: findingFindMany },
    requirement: { findMany: requirementFindMany },
    crossDocFinding: { findMany: crossDocFindMany },
  } as unknown as Parameters<typeof loadSourceGuard>[2];
  return { db, analysisFindMany, documentFindMany, findingFindMany, agentResultFindMany };
}

const RESTRICTED_ACL = JSON.stringify([{ kind: "user", value: "alice" }]);

describe("loadSourceGuard (#2447)", () => {
  it("reads nothing for no rows", async () => {
    const { db, analysisFindMany } = fakeDb([], []);
    const guard = await loadSourceGuard(BOB, [], db);
    expect(guard.canSee({ analysisId: "x", sourceIds: null })).toBe(true);
    expect(analysisFindMany).not.toHaveBeenCalled();
  });

  it("reads no document and resolves no reader for a run from before #2446", async () => {
    const { db, documentFindMany } = fakeDb([{ id: "a", projectId: "p1", sourceAccess: null }], []);
    const reader = vi.fn(async () => BOB);
    const guard = await loadSourceGuard(reader, [{ analysisId: "a", sourceIds: ids(["d1"]) }], db);
    expect(guard.canSee({ analysisId: "a", sourceIds: ids(["d1"]) })).toBe(true);
    expect(documentFindMany).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("resolves the reader only when a cited document is restricted", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "shared" };
    const open = fakeDb([run], [{ id: "d1", projectId: "p1", aclSubjects: "[]" }]);
    const reader = vi.fn(async () => BOB);
    await loadSourceGuard(reader, [{ analysisId: "a", sourceIds: ids(["d1"]) }], open.db);
    expect(reader).not.toHaveBeenCalled();

    const closed = fakeDb([run], [{ id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL }]);
    const guard = await loadSourceGuard(
      reader,
      [{ analysisId: "a", sourceIds: ids(["d1"]) }],
      closed.db,
    );
    expect(reader).toHaveBeenCalledTimes(1);
    expect(guard.canSee({ analysisId: "a", sourceIds: ids(["d1"]) })).toBe(false);
  });

  it("reads a shared run's recorded sources only for a row resting on the run as a whole", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "shared" };
    const docs = [
      { id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL },
      { id: "d2", projectId: "p1", aclSubjects: "[]" },
    ];
    const recorded = [
      { analysisId: "a", sourceIds: ids(["d2"]) },
      { analysisId: "a", sourceIds: ids(["d1"]) },
    ];
    const listed = fakeDb([run], docs, recorded);
    await loadSourceGuard(BOB, [{ analysisId: "a", sourceIds: ids(["d2"]) }], listed.db);
    expect(listed.findingFindMany).not.toHaveBeenCalled();

    const wide = fakeDb([run], docs, recorded);
    const reader = vi.fn(async () => BOB);
    const guard = await loadSourceGuard(reader, [{ analysisId: "a", sourceIds: null }], wide.db);
    // The recorded lists, then the findings with none (a failed read).
    expect(wide.findingFindMany).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(guard.canSeeRun("a")).toBe(false);
    expect(guard.canSee({ analysisId: "a", sourceIds: null })).toBe(false);
    const alice = await loadSourceGuard(ALICE, [{ analysisId: "a", sourceIds: null }], wide.db);
    expect(alice.canSeeRun("a")).toBe(true);
  });

  it("fails closed when a finding's sources were not recorded: every document of the project counts", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "shared" };
    const docs = [
      { id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL },
      { id: "d2", projectId: "p1", aclSubjects: "[]" },
      { id: "d9", projectId: "p2", aclSubjects: RESTRICTED_ACL },
    ];
    // Only d2 is recorded; the finding whose read failed may have cited d1.
    const recorded = [{ analysisId: "a", sourceIds: ids(["d2"]) }];
    const rows = [{ analysisId: "a", sourceIds: null }];
    const failed = fakeDb([run], docs, recorded, ["a"]);
    const bob = await loadSourceGuard(BOB, rows, failed.db);
    expect(bob.canSeeRun("a")).toBe(false);
    expect(bob.canSee(rows[0]!)).toBe(false);
    expect((await loadSourceGuard(ALICE, rows, failed.db)).canSeeRun("a")).toBe(true);
    // Every read failed: no corpus recorded at all, still closed.
    const none = fakeDb([run], docs, [], ["a"]);
    expect((await loadSourceGuard(BOB, rows, none.db)).canSeeRun("a")).toBe(false);
    // Every read recorded: the recorded corpus alone decides.
    const ok = fakeDb([run], docs, recorded);
    expect((await loadSourceGuard(BOB, rows, ok.db)).canSeeRun("a")).toBe(true);
  });

  it("counts a document a requirement or a cross-document finding records in the corpus", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "shared" };
    const docs = [{ id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL }];
    const rows = [{ analysisId: "a", sourceIds: null }];
    for (const kind of ["requirement", "crossDoc"] as const) {
      const { db } = fakeDb([run], docs, [{ analysisId: "a", sourceIds: ids(["d1"]), kind }]);
      expect((await loadSourceGuard(BOB, rows, db)).canSeeRun("a")).toBe(false);
      expect((await loadSourceGuard(ALICE, rows, db)).canSeeRun("a")).toBe(true);
    }
  });

  it("resolves the reader for a row resting on a run under a non-shared marker", async () => {
    const { db } = fakeDb([{ id: "a", projectId: "p1", sourceAccess: "future" }], []);
    const reader = vi.fn(async () => ADMIN);
    const guard = await loadSourceGuard(reader, [{ analysisId: "a", sourceIds: null }], db);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(guard.canSeeRun("a")).toBe(true);
  });

  it("fails closed for an inactive reader, and rethrows any other failure", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "shared" };
    const { db } = fakeDb(
      [run],
      [
        { id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL },
        { id: "d2", projectId: "p1", aclSubjects: "[]" },
      ],
    );
    const rows = [
      { analysisId: "a", sourceIds: ids(["d1"]) },
      { analysisId: "a", sourceIds: ids(["d2"]) },
    ];
    const guard = await loadSourceGuard(
      async () => {
        throw new InactiveAclActorError();
      },
      rows,
      db,
    );
    expect(rows.map((r) => guard.canSee(r))).toEqual([false, true]);
    await expect(
      loadSourceGuard(
        async () => {
          throw new Error("db down");
        },
        rows,
        db,
      ),
    ).rejects.toThrow("db down");
  });

  it("reads a large result in a bounded number of queries", async () => {
    const docRows = Array.from({ length: 1_200 }, (_, i) => ({
      id: `d${i}`,
      projectId: "p1",
      aclSubjects: i % 10 === 0 ? RESTRICTED_ACL : "[]",
    }));
    const { db, analysisFindMany, documentFindMany } = fakeDb(
      [{ id: "a", projectId: "p1", sourceAccess: "shared" }],
      docRows,
    );
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      analysisId: "a",
      sourceIds: ids([`d${i % 1_200}`, `d${(i * 7) % 1_200}`]),
    }));
    const reader = vi.fn(async () => BOB);
    const guard = await loadSourceGuard(reader, rows, db);
    expect(analysisFindMany).toHaveBeenCalledTimes(1);
    // 1,200 distinct documents, read 500 at a time.
    expect(documentFindMany).toHaveBeenCalledTimes(3);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(guard.canSee(rows[0]!)).toBe(false); // d0 is restricted to alice
    expect(guard.canSee(rows[1]!)).toBe(true);
  });

  it("audits an admin shown a restricted document's rows through the bypass (#2297)", async () => {
    auditSpy.mockClear();
    const { db } = fakeDb(
      [
        { id: "a", projectId: "p1", sourceAccess: "shared" },
        { id: "b", projectId: "p2", sourceAccess: "shared" },
      ],
      [
        { id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL },
        { id: "d2", projectId: "p1", aclSubjects: "[]" },
        {
          id: "d3",
          projectId: "p1",
          aclSubjects: JSON.stringify([{ kind: "role", value: "admin" }]),
        },
        { id: "d4", projectId: "p2", aclSubjects: RESTRICTED_ACL },
        // Cited by a run of another project: the row is hidden, not bypassed.
        { id: "d5", projectId: "p9", aclSubjects: RESTRICTED_ACL },
      ],
    );
    const rows = [
      { analysisId: "a", sourceIds: ids(["d1", "d2", "d3"]) },
      { analysisId: "b", sourceIds: ids(["d4"]) },
      { analysisId: "a", sourceIds: ids(["d5"]) },
    ];
    const guard = await loadSourceGuard(ADMIN, rows, db);
    expect(rows.map((r) => guard.canSee(r))).toEqual([true, true, false]);
    // Only what no subject names the admin on (d3 names their role), per project.
    expect(auditSpy.mock.calls.map(([e]) => e)).toEqual([
      {
        actor: { id: "root" },
        action: "analysis.source_redaction.acl_bypass",
        target: { type: "project", id: "p1" },
        metadata: { reason: "adminBypass", role: "admin", documentIds: ["d1"] },
      },
      {
        actor: { id: "root" },
        action: "analysis.source_redaction.acl_bypass",
        target: { type: "project", id: "p2" },
        metadata: { reason: "adminBypass", role: "admin", documentIds: ["d4"] },
      },
    ]);

    // A reader named on the list, the shared audience, or an open document: no row.
    auditSpy.mockClear();
    await loadSourceGuard(ALICE, rows, db);
    await loadSourceGuard(sharedSourceReader(), rows, db);
    await loadSourceGuard(ADMIN, [{ analysisId: "a", sourceIds: ids(["d2"]) }], db);
    expect(auditSpy).not.toHaveBeenCalled();

    // An audit failure never breaks the read.
    auditSpy.mockImplementationOnce(() => {
      throw new Error("audit down");
    });
    await expect(loadSourceGuard(ADMIN, rows, db)).resolves.toBeDefined();
  });

  it("restrictedIds names the rows the reader cannot see, and reads nothing for none", async () => {
    const { db, analysisFindMany } = fakeDb(
      [{ id: "a", projectId: "p1", sourceAccess: "shared" }],
      [{ id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL }],
    );
    expect(await restrictedIds(BOB, [], db)).toEqual(new Set());
    expect(analysisFindMany).not.toHaveBeenCalled();
    const hidden = await restrictedIds(
      sharedSourceReader(),
      [
        { id: "r1", analysisId: "a", sourceIds: ids(["d1"]) },
        { id: "r2", analysisId: "a", sourceIds: null },
      ],
      db,
    );
    expect(hidden).toEqual(new Set(["r1"]));
  });
});

type Finding = AnalysisSnapshot["agents"][number]["findings"][number];
type Requirement = AnalysisSnapshot["requirements"][number];

const FINDING: Finding = {
  id: "f1",
  category: "security",
  severity: "high",
  title: "Secret token in config.ts",
  body: "config.ts line 4 holds the key",
  tags: ["secret"],
  citations: [{ kind: "code", filePath: "src/config.ts", startLine: 4, endLine: 4 } as never],
  derivation: "extracted",
  confidence: 0.9,
  agentResultId: "ar1",
  requirementId: "REQ-1",
  verificationStatus: "confirmed",
  verdict: "gap-confirmed" as never,
  supportPanel: null,
  faithfulness: null,
};

const REQUIREMENT: Requirement = {
  id: "q1",
  type: "feature",
  title: "Rotate the secret token",
  body: "From config.ts",
  priority: "high",
  labels: ["security", "finding:f1"],
  storyPoints: 3,
  reviewStatus: "draft",
  evidenceFindingIds: ["f1"],
  coverage: "partial" as never,
  verdict: null,
  kind: "functional",
  nfrCategory: null,
  acceptanceCriteria: ["Token is rotated"],
  version: 2,
  analysedVersion: 1,
  supportConfidence: null,
  sourceItems: [],
  selfApprovalForbidden: true,
};

const CROSS_DOC: CrossDocFinding = {
  id: "c1",
  kind: "contradiction",
  severity: "medium",
  title: "Spec and config disagree",
  detail: "spec.md says X, config says Y",
  evidenceIds: ["f1"],
  scope: "pairwise",
};

describe("placeholders (#2447)", () => {
  it("a finding keeps its id, category, severity and provenance, and nothing it says", () => {
    const r = restrictedFinding(FINDING);
    expect(r).toMatchObject({
      id: "f1",
      category: "security",
      severity: "high",
      agentResultId: "ar1",
      title: RESTRICTED_SOURCE_TITLE,
      body: RESTRICTED_SOURCE_BODY,
      tags: [],
      citations: [],
      requirementId: null,
      verificationStatus: null,
      verdict: null,
      restricted: true,
    });
    expect(JSON.stringify(r)).not.toMatch(/config|secret|REQ-1/i);
  });

  it("a requirement keeps its id, status, version and size, and nothing it says", () => {
    const r = restrictedRequirement(REQUIREMENT);
    expect(r).toMatchObject({
      id: "q1",
      reviewStatus: "draft",
      version: 2,
      analysedVersion: 1,
      storyPoints: 3,
      title: RESTRICTED_SOURCE_TITLE,
      labels: [],
      evidenceFindingIds: [],
      acceptanceCriteria: [],
      coverage: null,
      restricted: true,
    });
    expect(JSON.stringify(r)).not.toMatch(/config|secret|rotate/i);
    expect(
      restrictedRequirement({ ...REQUIREMENT, analysedVersion: undefined }),
    ).not.toHaveProperty("analysedVersion");
  });

  it("a cross-document finding keeps its kind and severity", () => {
    const r = restrictedCrossDocFinding(CROSS_DOC);
    expect(r).toEqual({
      id: "c1",
      kind: "contradiction",
      severity: "medium",
      title: RESTRICTED_SOURCE_TITLE,
      detail: RESTRICTED_SOURCE_BODY,
      evidenceIds: [],
      scope: "pairwise",
      restricted: true,
    });
  });
});

describe("redactAnalysisSnapshot (#2447)", () => {
  const snapshot = {
    id: "shared-run",
    projectId: "p1",
    agents: [
      {
        agentKey: "code",
        summary: "Read config.ts",
        notes: ["config.ts"],
        findings: [FINDING, { ...FINDING, id: "f2", title: "Open finding" }],
      },
    ],
    requirements: [REQUIREMENT, { ...REQUIREMENT, id: "q2", title: "Open requirement" }],
    crossDocFindings: { findings: [CROSS_DOC, { ...CROSS_DOC, id: "c2" }] },
  } as unknown as AnalysisSnapshot;
  const sources = {
    findings: new Map([
      ["f1", ids(["d-alice"])],
      ["f2", ids(["d-open"])],
    ]),
    requirements: new Map([
      ["q1", ids(["d-alice"])],
      ["q2", null],
    ]),
    crossDocFindings: new Map([
      ["c1", ids(["d-alice"])],
      ["c2", ids([])],
    ]),
  };

  it("redacts each row the reader cannot see, row by row, and never the whole result", () => {
    const out = redactAnalysisSnapshot(snapshot, sources, guardFor(BOB));
    expect(out.agents[0]!.findings.map((f) => f.title)).toEqual(["Restricted", "Open finding"]);
    expect(out.requirements.map((r) => r.title)).toEqual(["Restricted", "Open requirement"]);
    expect(out.crossDocFindings!.findings.map((f) => f.restricted ?? false)).toEqual([true, false]);
    expect(out.agents[0]!.summary).toBe("Read config.ts");
  });

  it("shows everything to a reader who can see every source", () => {
    const out = redactAnalysisSnapshot(snapshot, sources, guardFor(ALICE));
    expect(out).toEqual(snapshot);
  });

  it("empties an agent's narrative when the reader cannot see the run as a whole", () => {
    const starter = { ...snapshot, id: "other-run" } as AnalysisSnapshot;
    const out = redactAnalysisSnapshot(starter, sources, guardFor(ALICE));
    expect(out.agents[0]).toMatchObject({ summary: null, notes: [] });
    // A row with no record rests on that run, so it goes too.
    expect(out.requirements.map((r) => r.restricted ?? false)).toEqual([false, true]);
  });

  it("treats a row the snapshot has but the record map lacks as having no record", () => {
    const out = redactAnalysisSnapshot(
      { ...snapshot, id: "other-run" } as AnalysisSnapshot,
      { findings: new Map(), requirements: new Map(), crossDocFindings: new Map() },
      guardFor(BOB),
    );
    expect(out.agents[0]!.findings.every((f) => f.restricted)).toBe(true);
  });

  it("redacts the reviewed list in metadata: a promoted entry with its requirement, an unpromoted one with the run", () => {
    const entry = (id: string, title: string) => ({
      id,
      title,
      description: title,
      type: "functional",
      priority: "must",
    });
    const withList = (id: string) =>
      ({
        ...snapshot,
        id,
        metadata: {
          structuredRequirements: {
            requirements: [
              entry("s1", "Secret entry"),
              entry("s2", "Open entry"),
              entry("s3", "Unpromoted"),
            ],
          },
        },
      }) as unknown as AnalysisSnapshot;
    const promoted = {
      ...sources,
      promotedStructuredIds: new Map([
        ["q1", "s1"],
        ["q2", "s2"],
      ]),
    };
    const titles = (out: AnalysisSnapshot) =>
      (
        out.metadata?.structuredRequirements as { requirements: Array<{ title: string }> }
      ).requirements.map((r) => r.title);
    // A shared run: the entry promoted into a hidden requirement goes; the rest stay.
    expect(titles(redactAnalysisSnapshot(withList("shared-run"), promoted, guardFor(BOB)))).toEqual(
      ["Restricted", "Open entry", "Unpromoted"],
    );
    // A run Alice cannot see as a whole: the unpromoted entry rests on it, so it goes too.
    expect(
      titles(redactAnalysisSnapshot(withList("other-run"), promoted, guardFor(ALICE))),
    ).toEqual(["Secret entry", "Restricted", "Restricted"]);
  });

  it("leaves a run with no cross-document pass as it was", () => {
    const out = redactAnalysisSnapshot(
      { ...snapshot, crossDocFindings: null } as AnalysisSnapshot,
      sources,
      guardFor(BOB),
    );
    expect(out.crossDocFindings).toBeNull();
  });
});

describe("#2491 — inputs, coverage and requirement ids", () => {
  it("inputDocumentIds reads the string ids of `metadata.documentIds`, and nothing from anything else", () => {
    expect(inputDocumentIds(JSON.stringify({ documentIds: ["d1", 2, "d2"] }))).toEqual([
      "d1",
      "d2",
    ]);
    for (const raw of [
      null,
      undefined,
      "",
      "not json",
      "null",
      "5",
      JSON.stringify({ documentIds: "d1" }),
    ]) {
      expect(inputDocumentIds(raw)).toEqual([]);
    }
  });

  it("documentCoverageRows names one single-document row per document the coverage record lists", () => {
    const snapshot = {
      id: "a",
      capability: { documentReading: { documents: [{ documentId: "d1" }, { documentId: "d2" }] } },
    } as unknown as AnalysisSnapshot;
    expect(documentCoverageRows(snapshot)).toEqual([
      documentSourceRow("a", "d1"),
      documentSourceRow("a", "d2"),
    ]);
    expect(
      documentCoverageRows({ id: "a", capability: null } as unknown as AnalysisSnapshot),
    ).toEqual([]);
  });

  it("restrictedRequirementIds reads nothing for no ids, and asks the guard about each row it finds", async () => {
    const findMany = vi.fn(async () => [{ id: "r1", analysisId: "a", sourceIds: ids(["d1"]) }]);
    const db = {
      requirement: { findMany },
      analysis: {
        findMany: vi.fn(async () => [{ id: "a", projectId: "p1", sourceAccess: "shared" }]),
      },
      document: {
        findMany: vi.fn(async () => [
          {
            id: "d1",
            projectId: "p1",
            aclSubjects: JSON.stringify([{ kind: "user", value: "alice" }]),
          },
        ]),
      },
    } as unknown as Parameters<typeof restrictedRequirementIds>[2];
    expect(await restrictedRequirementIds(BOB, [], db)).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
    expect(await restrictedRequirementIds(BOB, ["r1", "r1"], db)).toEqual(new Set(["r1"]));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(await restrictedRequirementIds(ALICE, ["r1"], db)).toEqual(new Set());
  });
});

describe("#2448 — a run read with the access of whoever ran each pass", () => {
  const starterRuns = new Map([
    ...runs,
    ["starter-run", { projectId: "p1", sourceAccess: "starter" }],
  ]);
  const guard = (actor: AclActor | null, corpus: Set<string>) =>
    sourceGuardOf({
      runs: starterRuns,
      documents,
      actor,
      corpus: new Map([["starter-run", corpus]]),
    });

  it("decides what rests on the run as a whole by what it read, as each access list is now", () => {
    // Alice's pass read d-alice: Bob cannot see the run as a whole, Alice and an admin can.
    const read = new Set(["d-open", "d-alice"]);
    expect(guard(BOB, read).canSeeRun("starter-run")).toBe(false);
    expect(guard(BOB, read).canSee({ analysisId: "starter-run", sourceIds: null })).toBe(false);
    expect(guard(ALICE, read).canSeeRun("starter-run")).toBe(true);
    expect(guard(ADMIN, read).canSeeRun("starter-run")).toBe(true);
    expect(guard(SHARED, read).canSeeRun("starter-run")).toBe(false);
    // A run that read nothing restricted: every member, as before.
    expect(guard(BOB, new Set(["d-open"])).canSeeRun("starter-run")).toBe(true);
    // A row with its own list is still decided by that list alone.
    expect(
      guard(BOB, read).canSee({
        analysisId: "starter-run",
        sourceIds: ids(["d-open"]),
      }),
    ).toBe(true);
  });

  it("adds each pass's read set to the corpus, in one more read", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "starter" };
    const docs = [
      { id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL },
      { id: "d2", projectId: "p1", aclSubjects: "[]" },
    ];
    const rows = [{ analysisId: "a", sourceIds: null }];
    // No row cites d1; only the pass that read it records it.
    const recorded = [{ analysisId: "a", sourceIds: ids(["d2"]) }];
    const read = fakeDb(
      [run],
      docs,
      recorded,
      [],
      [{ analysisId: "a", readSourceIds: ids(["d1"]) }],
    );
    expect((await loadSourceGuard(BOB, rows, read.db)).canSeeRun("a")).toBe(false);
    expect((await loadSourceGuard(ALICE, rows, read.db)).canSeeRun("a")).toBe(true);
    expect(read.agentResultFindMany).toHaveBeenCalledWith({
      where: { analysisId: { in: ["a"] } },
      select: { analysisId: true, readSourceIds: true },
    });
    // Its passes read nothing restricted: every member.
    const open = fakeDb([run], docs, recorded, [], [{ analysisId: "a", readSourceIds: ids([]) }]);
    expect((await loadSourceGuard(BOB, rows, open.db)).canSeeRun("a")).toBe(true);
  });

  it("fails closed on a pass that recorded no read set: every document of the project counts", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "starter" };
    const docs = [
      { id: "d1", projectId: "p1", aclSubjects: RESTRICTED_ACL },
      { id: "d2", projectId: "p1", aclSubjects: "[]" },
    ];
    const rows = [{ analysisId: "a", sourceIds: null }];
    for (const readSourceIds of [null, "{not json"]) {
      const { db } = fakeDb([run], docs, [], [], [{ analysisId: "a", readSourceIds }]);
      expect((await loadSourceGuard(BOB, rows, db)).canSeeRun("a")).toBe(false);
      expect((await loadSourceGuard(ALICE, rows, db)).canSeeRun("a")).toBe(true);
    }
  });

  it("never reads a shared run's passes: it recorded none, and needs none", async () => {
    const run = { id: "a", projectId: "p1", sourceAccess: "shared" };
    const { db, agentResultFindMany } = fakeDb(
      [run],
      [{ id: "d2", projectId: "p1", aclSubjects: "[]" }],
      [{ analysisId: "a", sourceIds: ids(["d2"]) }],
      [],
      [{ analysisId: "a", readSourceIds: null }],
    );
    expect(
      (await loadSourceGuard(BOB, [{ analysisId: "a", sourceIds: null }], db)).canSeeRun("a"),
    ).toBe(true);
    expect(agentResultFindMany).not.toHaveBeenCalled();
  });

  it("empties the run-wide records a code pass wrote for a reader who cannot see the run", () => {
    const capability = {
      reasons: [],
      findingsLeftOut: [
        {
          agentKey: "code",
          producedCount: 52,
          keptCount: 50,
          leftOutTitles: ["Secret in vault.ts"],
        },
      ],
    };
    const retrieval = {
      successfulSearches: 1,
      failedSearches: 0,
      erroredCalls: 0,
      degraded: false,
      searchedScope: [{ tool: "read_file_slice", query: "src/vault.ts", hit: true }],
    };
    const run = {
      id: "starter-run",
      projectId: "p1",
      agents: [],
      requirements: [],
      crossDocFindings: null,
      capability,
      retrieval,
      metadata: { capability, retrieval, model: "m" },
    } as unknown as AnalysisSnapshot;
    const none = {
      findings: new Map(),
      requirements: new Map(),
      crossDocFindings: new Map(),
    };
    const bob = redactAnalysisSnapshot(run, none, guard(BOB, new Set(["d-alice"])));
    expect(JSON.stringify(bob)).not.toMatch(/vault/);
    expect(bob.capability!.findingsLeftOut).toEqual([
      { agentKey: "code", producedCount: 52, keptCount: 50, leftOutTitles: [] },
    ]);
    expect(bob.retrieval!.searchedScope).toEqual([{ tool: "read_file_slice", hit: true }]);
    expect(bob.metadata).toMatchObject({ model: "m" });
    // Alice can see everything it read: nothing is emptied.
    expect(redactAnalysisSnapshot(run, none, guard(ALICE, new Set(["d-alice"])))).toEqual(run);
  });

  it("redactRunCapability keeps the counts and leaves a record with nothing cut alone", () => {
    const cut = {
      reasons: [],
      findingsLeftOut: [
        {
          agentKey: "code",
          producedCount: 3,
          keptCount: 1,
          leftOutTitles: ["a", "b"],
        },
      ],
    } as unknown as NonNullable<AnalysisSnapshot["capability"]>;
    expect(redactRunCapability(cut)!.findingsLeftOut).toEqual([
      { agentKey: "code", producedCount: 3, keptCount: 1, leftOutTitles: [] },
    ]);
    const plain = { reasons: [] } as unknown as NonNullable<AnalysisSnapshot["capability"]>;
    expect(redactRunCapability(plain)).toBe(plain);
    expect(redactRunCapability(null)).toBeNull();
  });
});
