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
  loadSourceGuard,
  redactAnalysisSnapshot,
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
  ["starter-run", { projectId: "p1", sourceAccess: "starter" }],
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
    expect(guardFor(BOB).canSee({ analysisId: "starter-run", sourceIds: null })).toBe(false);
    expect(guardFor(ALICE).canSeeRun("starter-run")).toBe(false);
    expect(guardFor(ADMIN).canSee({ analysisId: "starter-run", sourceIds: null })).toBe(true);
    expect(guardFor(null).canSeeRun("starter-run")).toBe(false);
  });

  it("reads an unparseable record as no record, never as an empty one", () => {
    expect(guardFor(BOB).canSee({ analysisId: "starter-run", sourceIds: "[]" })).toBe(false);
    expect(guardFor(BOB).canSee({ analysisId: "starter-run", sourceIds: "{not json" })).toBe(false);
  });

  it("hides a row of a run it cannot find", () => {
    expect(guardFor(ADMIN).canSee({ analysisId: "gone", sourceIds: ids([]) })).toBe(false);
    expect(guardFor(ADMIN).canSeeRun("gone")).toBe(false);
  });
});

/** A fake of the two reads the loader makes, counting them. */
function fakeDb(
  runRows: Array<{ id: string; projectId: string; sourceAccess: string | null }>,
  docRows: Array<{ id: string; projectId: string; aclSubjects: string }>,
) {
  const analysisFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    runRows.filter((r) => where.id.in.includes(r.id)),
  );
  const documentFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    docRows.filter((d) => where.id.in.includes(d.id)),
  );
  const db = {
    analysis: { findMany: analysisFindMany },
    document: { findMany: documentFindMany },
  } as unknown as Parameters<typeof loadSourceGuard>[2];
  return { db, analysisFindMany, documentFindMany };
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

  it("resolves the reader for a row resting on a run under a non-shared marker", async () => {
    const { db } = fakeDb([{ id: "a", projectId: "p1", sourceAccess: "starter" }], []);
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
    const starter = { ...snapshot, id: "starter-run" } as AnalysisSnapshot;
    const out = redactAnalysisSnapshot(starter, sources, guardFor(ALICE));
    expect(out.agents[0]).toMatchObject({ summary: null, notes: [] });
    // A row with no record rests on that run, so it goes too.
    expect(out.requirements.map((r) => r.restricted ?? false)).toEqual([false, true]);
  });

  it("treats a row the snapshot has but the record map lacks as having no record", () => {
    const out = redactAnalysisSnapshot(
      { ...snapshot, id: "starter-run" } as AnalysisSnapshot,
      { findings: new Map(), requirements: new Map(), crossDocFindings: new Map() },
      guardFor(BOB),
    );
    expect(out.agents[0]!.findings.every((f) => f.restricted)).toBe(true);
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
