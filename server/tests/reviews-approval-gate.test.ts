/**
 * Epic #609 (#619) — publish/export approval gate.
 *
 * The gate blocks publishing IssueDrafts and exporting requirements /
 * generated documents when `Project.requireApprovedReview` is enabled and
 * the artifact lacks an APPROVED review pinned to its CURRENT version.
 *
 * Security posture under test:
 *   - FAIL CLOSED: any error during the check (project missing, prisma
 *     throwing, unknown flag value) blocks the operation.
 *   - Staleness: an approved review pinned to an older version does not
 *     satisfy the gate (approved → content changed → stale).
 *   - Unlinked drafts (no traceable requirement) are blocked when the gate
 *     is on — a deleted requirement (FK SetNull) must not un-gate a draft.
 *   - Blocked decisions are audited.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  requireApprovedReview: boolean | null;
}
interface RequirementRow {
  id: string;
  projectId: string;
  version: number;
  deletedAt: Date | null;
}
interface ReviewItemRow {
  requirementId: string | null;
  generatedDocumentId: string | null;
  pinnedVersion: number;
  reviewStatus: string; // status of the owning ReviewRequest
  reviewProjectId: string;
}
interface DocRow {
  id: string;
  projectId: string;
  deletedAt: Date | null;
}

const projects = new Map<string, ProjectRow>();
const requirements = new Map<string, RequirementRow>();
const docs = new Map<string, DocRow>();
let reviewItems: ReviewItemRow[] = [];
let docLatestVersion = new Map<string, number>();
/** When set, prisma.project.findUnique throws — simulates a DB outage. */
let projectLookupThrows = false;
/** When set, reviewRequestItem.findMany throws mid-check. */
let reviewLookupThrows = false;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (projectLookupThrows) throw new Error("db down");
        return projects.get(where.id) ?? null;
      }),
    },
    requirement: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; projectId: string } }) =>
        [...requirements.values()].filter(
          (r) => where.id.in.includes(r.id) && r.projectId === where.projectId && !r.deletedAt,
        ),
      ),
    },
    reviewRequestItem: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            requirementId?: { in: string[] };
            generatedDocumentId?: string;
            reviewRequest: { status: string; projectId: string };
          };
        }) => {
          if (reviewLookupThrows) throw new Error("review lookup failed");
          return reviewItems.filter((i) => {
            if (i.reviewStatus !== where.reviewRequest.status) return false;
            if (i.reviewProjectId !== where.reviewRequest.projectId) return false;
            if (where.requirementId) {
              // Loose store simulation: also return doc-pin rows (null
              // requirementId) so the gate's own null-guard is exercised.
              return i.requirementId === null || where.requirementId.in.includes(i.requirementId);
            }
            if (where.generatedDocumentId) {
              return i.generatedDocumentId === where.generatedDocumentId;
            }
            return false;
          });
        },
      ),
    },
    generatedDocument: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) => {
        const doc = docs.get(where.id);
        if (!doc || doc.projectId !== where.projectId || doc.deletedAt) return null;
        return doc;
      }),
    },
    generatedDocumentVersion: {
      findFirst: vi.fn(async ({ where }: { where: { documentId: string } }) => {
        const v = docLatestVersion.get(where.documentId);
        return v === undefined ? null : { version: v };
      }),
    },
  },
}));

const auditMock = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));

const {
  assertDraftsPublishable,
  assertRequirementsExportable,
  assertDocumentExportable,
  collectDraftRequirementIds,
} = await import("../src/lib/reviews/approval-gate.js");

function seedProject(id: string, flag: boolean | null): void {
  projects.set(id, { id, requireApprovedReview: flag });
}
function seedRequirement(id: string, projectId: string, version: number): void {
  requirements.set(id, { id, projectId, version, deletedAt: null });
}
function seedApprovedItem(requirementId: string, pinnedVersion: number, projectId = "p1"): void {
  reviewItems.push({
    requirementId,
    generatedDocumentId: null,
    pinnedVersion,
    reviewStatus: "approved",
    reviewProjectId: projectId,
  });
}

const draft = (
  id: string,
  requirementId: string | null,
  metadata: Record<string, unknown> | null = null,
) => ({
  id,
  requirementId,
  metadata: metadata ? JSON.stringify(metadata) : null,
});

beforeEach(() => {
  projects.clear();
  requirements.clear();
  docs.clear();
  reviewItems = [];
  docLatestVersion = new Map();
  projectLookupThrows = false;
  reviewLookupThrows = false;
  auditMock.mockClear();
});

// ---------------------------------------------------------------------------
// collectDraftRequirementIds (pure)
// ---------------------------------------------------------------------------

describe("collectDraftRequirementIds", () => {
  it("uses the FK when present", () => {
    expect(collectDraftRequirementIds(draft("d1", "r1"))).toEqual(["r1"]);
  });

  it("merges metadata requirementId / requirementIds / mappedRequirementIds", () => {
    const ids = collectDraftRequirementIds(
      draft("d1", "r1", {
        requirementId: "r2",
        requirementIds: ["r3", "r4"],
        mappedRequirementIds: ["r4", "r5"],
      }),
    );
    expect([...ids].sort()).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("returns empty for an unlinked draft with no metadata refs", () => {
    expect(collectDraftRequirementIds(draft("d1", null))).toEqual([]);
    expect(collectDraftRequirementIds(draft("d1", null, { generator: "x" }))).toEqual([]);
  });

  it("ignores malformed metadata JSON and non-string entries", () => {
    expect(
      collectDraftRequirementIds({ id: "d1", requirementId: null, metadata: "{not json" }),
    ).toEqual([]);
    expect(
      collectDraftRequirementIds(draft("d1", null, { requirementIds: [42, null, "r1"] })),
    ).toEqual(["r1"]);
  });
});

// ---------------------------------------------------------------------------
// assertDraftsPublishable
// ---------------------------------------------------------------------------

describe("assertDraftsPublishable", () => {
  it("is a no-op when the flag is explicitly false (regression: gate off)", async () => {
    seedProject("p1", false);
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: [draft("d1", "r-unreviewed")],
        context: "test",
      }),
    ).resolves.toBeUndefined();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("allows drafts whose requirement has an approved, current review", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 3);
    seedApprovedItem("r1", 3);
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).resolves.toBeUndefined();
  });

  it("blocks with 409 APPROVAL_REQUIRED listing offending requirement ids", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 1);
    seedRequirement("r2", "p1", 1);
    seedApprovedItem("r1", 1);
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: [draft("d1", "r1"), draft("d2", "r2")],
        context: "test",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
      details: { requirementIds: ["r2"] },
    });
  });

  it("blocks a STALE approval (pinned version older than current)", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 5);
    seedApprovedItem("r1", 4); // approved at v4, content now at v5
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_REQUIRED" });
  });

  it("ignores approvals from reviews that are not approved (in_review / rejected)", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 2);
    reviewItems.push({
      requirementId: "r1",
      generatedDocumentId: null,
      pinnedVersion: 2,
      reviewStatus: "in_review",
      reviewProjectId: "p1",
    });
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("ignores approved reviews from ANOTHER project (no cross-project satisfaction)", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 2);
    seedApprovedItem("r1", 2, "p-other");
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("blocks unlinked drafts (no requirement FK, no metadata refs) — SetNull bypass", async () => {
    seedProject("p1", true);
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", null)], context: "test" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
      details: { unlinkedDraftIds: ["d1"] },
    });
  });

  it("resolves epic drafts through metadata.requirementIds", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 1);
    seedRequirement("r2", "p1", 1);
    seedApprovedItem("r1", 1);
    seedApprovedItem("r2", 1);
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: [draft("epic", null, { requirementIds: ["r1", "r2"] })],
        context: "test",
      }),
    ).resolves.toBeUndefined();
  });

  it("treats a requirement id that no longer resolves in this project as unapproved", async () => {
    seedProject("p1", true);
    // r-gone is referenced by the draft but does not exist / is deleted.
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: [draft("d1", "r-gone")],
        context: "test",
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { requirementIds: ["r-gone"] },
    });
  });

  it("FAIL CLOSED: project not found blocks", async () => {
    await expect(
      assertDraftsPublishable({
        projectId: "p-missing",
        drafts: [draft("d1", "r1")],
        context: "test",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" });
  });

  it("FAIL CLOSED: a flag value that is not explicitly false enforces the gate", async () => {
    // Simulates a misconfigured / unknown value reaching the check.
    seedProject("p1", null);
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", null)], context: "test" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("FAIL CLOSED: a DB error during the flag lookup blocks with 503", async () => {
    projectLookupThrows = true;
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
  });

  it("FAIL CLOSED: a DB error during the review lookup blocks with 503", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 1);
    reviewLookupThrows = true;
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
  });

  it("audits blocked decisions with the calling context", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 1);
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: [draft("d1", "r1")],
        context: "publish.batch.create",
        actorId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review.gate.blocked",
        metadata: expect.objectContaining({
          context: "publish.batch.create",
          requirementIds: ["r1"],
        }),
      }),
    );
  });

  it("supports a lazy draft loader that is only invoked when the gate is enforced", async () => {
    seedProject("p1", false);
    const loader = vi.fn(async () => [draft("d1", null)]);
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: loader, context: "test" }),
    ).resolves.toBeUndefined();
    expect(loader).not.toHaveBeenCalled();

    seedProject("p1", true);
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: loader, context: "test" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("ignores review items with a null requirementId (doc pins) when checking requirements", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 1);
    seedApprovedItem("r1", 1);
    // A doc pin in the same approved review must not confuse the requirement check.
    reviewItems.push({
      requirementId: null,
      generatedDocumentId: "doc1",
      pinnedVersion: 1,
      reviewStatus: "approved",
      reviewProjectId: "p1",
    });
    await expect(
      assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", "r1")], context: "test" }),
    ).resolves.toBeUndefined();
  });

  it("FAIL CLOSED: a non-Error throw is stringified and still blocks with 503", async () => {
    seedProject("p1", true);
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: async () => {
          throw "loader string failure";
        },
        context: "test",
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review.gate.error",
        metadata: expect.objectContaining({ error: "loader string failure" }),
      }),
    );
  });

  it("FAIL CLOSED: a lazy loader failure blocks with 503", async () => {
    seedProject("p1", true);
    await expect(
      assertDraftsPublishable({
        projectId: "p1",
        drafts: async () => {
          throw new Error("loader boom");
        },
        context: "test",
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
  });

  it("does not audit allowed decisions when the gate is off", async () => {
    seedProject("p1", false);
    await assertDraftsPublishable({ projectId: "p1", drafts: [draft("d1", null)], context: "t" });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// assertRequirementsExportable
// ---------------------------------------------------------------------------

describe("assertRequirementsExportable", () => {
  it("no-op when the flag is off", async () => {
    seedProject("p1", false);
    await expect(
      assertRequirementsExportable({
        projectId: "p1",
        requirementIds: ["r1"],
        context: "export",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows an approved-current requirement export", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 2);
    seedApprovedItem("r1", 2);
    await expect(
      assertRequirementsExportable({
        projectId: "p1",
        requirementIds: ["r1"],
        context: "export",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks an unapproved requirement export with 409", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 2);
    await expect(
      assertRequirementsExportable({
        projectId: "p1",
        requirementIds: ["r1"],
        context: "export",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
      details: { requirementIds: ["r1"] },
    });
  });

  it("blocks a stale approval on export", async () => {
    seedProject("p1", true);
    seedRequirement("r1", "p1", 3);
    seedApprovedItem("r1", 2);
    await expect(
      assertRequirementsExportable({
        projectId: "p1",
        requirementIds: ["r1"],
        context: "export",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("FAIL CLOSED on lookup errors", async () => {
    projectLookupThrows = true;
    await expect(
      assertRequirementsExportable({
        projectId: "p1",
        requirementIds: ["r1"],
        context: "export",
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------------------
// assertDocumentExportable
// ---------------------------------------------------------------------------

describe("assertDocumentExportable", () => {
  function seedDoc(id: string, projectId: string, latestVersion: number | null): void {
    docs.set(id, { id, projectId, deletedAt: null });
    if (latestVersion !== null) docLatestVersion.set(id, latestVersion);
  }
  function seedApprovedDocItem(docId: string, pinnedVersion: number, projectId = "p1"): void {
    reviewItems.push({
      requirementId: null,
      generatedDocumentId: docId,
      pinnedVersion,
      reviewStatus: "approved",
      reviewProjectId: projectId,
    });
  }

  it("no-op when the flag is off", async () => {
    seedProject("p1", false);
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "doc1", context: "doc.export" }),
    ).resolves.toBeUndefined();
  });

  it("allows an approved-current document export", async () => {
    seedProject("p1", true);
    seedDoc("doc1", "p1", 4);
    seedApprovedDocItem("doc1", 4);
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "doc1", context: "doc.export" }),
    ).resolves.toBeUndefined();
  });

  it("blocks an unreviewed document export with 409 + documentIds", async () => {
    seedProject("p1", true);
    seedDoc("doc1", "p1", 1);
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "doc1", context: "doc.export" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
      details: { documentIds: ["doc1"] },
    });
  });

  it("blocks a stale document approval (doc re-generated since approval)", async () => {
    seedProject("p1", true);
    seedDoc("doc1", "p1", 5);
    seedApprovedDocItem("doc1", 3);
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "doc1", context: "doc.export" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("uses version 0 when the document has no version rows (matches review pin semantics)", async () => {
    seedProject("p1", true);
    seedDoc("doc1", "p1", null); // no GeneratedDocumentVersion rows
    seedApprovedDocItem("doc1", 0);
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "doc1", context: "doc.export" }),
    ).resolves.toBeUndefined();
  });

  it("FAIL CLOSED: document not found in project blocks", async () => {
    seedProject("p1", true);
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "nope", context: "doc.export" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_REQUIRED" });
  });

  it("FAIL CLOSED on lookup errors", async () => {
    seedProject("p1", true);
    seedDoc("doc1", "p1", 1);
    reviewLookupThrows = true;
    await expect(
      assertDocumentExportable({ projectId: "p1", documentId: "doc1", context: "doc.export" }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
  });
});
