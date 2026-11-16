/**
 * Issue #2595 — `GET /api/impact-analyses/:id/export?format=docx|pdf`, the BA
 * hand-off as Word or PDF. The route layer: format validation, the same
 * authorization as `GET /:id`, the change request and the run's own answered
 * questions reaching the document, and the download headers. The document's
 * content is `handoff-export.test.ts`; the Word/PDF rendering of it is
 * `tests/unit/handoff-export-documents.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const m = vi.hoisted(() => ({
  permitRead: true,
  accessibleIds: ["project-001"] as string[],
  getImpactAnalysisDetail: vi.fn(),
  loadHandoffChangeRequest: vi.fn(),
  readSubjectDialog: vi.fn(),
  documentFindUnique: vi.fn(),
  canSeeDocument: vi.fn(),
  exportDocument: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = { userId: "user-1", role: "member" };
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "analysis.read" && !m.permitRead) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));
vi.mock("../lib/scheduler/project-access.js", () => ({
  isAdminActor: () => false,
  listMemberAccessibleProjectIds: vi.fn(async () => m.accessibleIds),
  actorHasProjectAccess: vi.fn(async (_a: unknown, pid: string) => m.accessibleIds.includes(pid)),
}));
vi.mock("../lib/impact-analysis/impact-analysis-read.js", () => ({
  listImpactAnalyses: vi.fn(async () => []),
  getImpactAnalysisDetail: m.getImpactAnalysisDetail,
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findMany: vi.fn(async () => [{ id: "project-001", name: "Miniflux" }]) },
    document: { findUnique: m.documentFindUnique },
  },
}));
vi.mock("../lib/impact-analysis/handoff-export.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/impact-analysis/handoff-export.js")>()),
  loadHandoffChangeRequest: m.loadHandoffChangeRequest,
}));
vi.mock("../lib/clarifications/subject-clarifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/clarifications/subject-clarifications.js")>()),
  readSubjectDialog: m.readSubjectDialog,
}));
vi.mock("../lib/documents/document-visibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/documents/document-visibility.js")>()),
  canSeeDocument: m.canSeeDocument,
}));
vi.mock("../lib/docs-gen/exporters.js", () => ({ exportDocument: m.exportDocument }));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { impactAnalysisRouter } = await import("./impact-analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

const app = express();
app.use(express.json());
app.use("/impact-analyses", impactAnalysisRouter());
app.use(errorHandler);

const detail = {
  id: "ia-1",
  status: "completed",
  documentId: null,
  sourceText: null,
  summary: "One requirement change.",
  errorMessage: null,
  totalImpactedSymbols: 1,
  startedAt: "2026-11-16T10:00:00.000Z",
  completedAt: "2026-11-16T10:05:00.000Z",
  projectIds: ["project-001"],
  projectOutcomes: [],
  startedById: "user-1",
  sourceAnalysisId: "cr-1",
  items: [],
  sharedTableImpacts: [],
};

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The markdown the route handed to the exporter, and the title and format. */
function exported(): { markdown: string; title: string; format: string } {
  const [markdown, title, format] = m.exportDocument.mock.calls[0]!;
  return { markdown, title, format };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.permitRead = true;
  m.accessibleIds = ["project-001"];
  m.getImpactAnalysisDetail.mockResolvedValue(detail);
  m.loadHandoffChangeRequest.mockResolvedValue({
    title: "Expiring API keys",
    restrictedLeftOut: 0,
    passagesWithheld: false,
    requirements: [
      {
        title: "Keys can expire",
        body: "A key may be given an expiry date.",
        approved: true,
        verdict: "could-not-verify",
        passages: [{ headingPath: ["FRD-12.1"], quote: "A key may expire." }],
      },
    ],
  });
  m.readSubjectDialog.mockResolvedValue(null);
  m.canSeeDocument.mockResolvedValue(true);
  m.documentFindUnique.mockResolvedValue({
    projectId: "project-001",
    deletedAt: null,
    aclSubjects: null,
  });
  m.exportDocument.mockImplementation(async (_md: string, title: string, format: string) => ({
    buffer: Buffer.from(`${format}-bytes`),
    mimeType: format === "pdf" ? "application/pdf" : DOCX,
    filename: `${title}.${format}`,
  }));
});

describe("GET /impact-analyses/:id/export — #2595", () => {
  it("downloads the hand-off as Word", async () => {
    const res = await request(app)
      .get("/impact-analyses/ia-1/export?format=docx")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(DOCX);
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="Expiring API keys - impact hand-off.docx"',
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect((res.body as Buffer).toString()).toBe("docx-bytes");
    const { markdown, title, format } = exported();
    expect(format).toBe("docx");
    expect(title).toBe("Expiring API keys - impact hand-off");
    // The change request reached the document: its requirement, passage and verdict.
    expect(markdown).toContain("### 1. Keys can expire");
    expect(markdown).toContain("> A key may expire.");
    expect(markdown).toContain("Requirement **Keys can expire**: the code could neither confirm");
    expect(markdown).toContain("One requirement change.");
    // Word's cover page carries the title: no H1 repeats it.
    expect(markdown).not.toMatch(/^# /m);
    // The change request is read now; the run is the stored one of its own date.
    const today = new Date().toISOString().slice(0, 10);
    expect(markdown).toContain(
      `*As of: the change request is shown as it reads on ${today}; ` +
        "the impact analysis is the run of 2026-11-16.",
    );
  });

  it("downloads the hand-off as PDF", async () => {
    const res = await request(app).get("/impact-analyses/ia-1/export?format=pdf");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(exported().format).toBe("pdf");
    expect(exported().markdown).toMatch(/^# Expiring API keys - impact hand-off$/m);
  });

  it("caps hand-off exports per user, Word and PDF alike, before any export runs", async () => {
    process.env.HANDOFF_EXPORT_LIMIT_MAX = "1";
    try {
      await request(app).get("/impact-analyses/ia-1/export?format=pdf");
      m.exportDocument.mockClear();
      for (const format of ["pdf", "docx"]) {
        const limited = await request(app).get(`/impact-analyses/ia-1/export?format=${format}`);
        expect(limited.status).toBe(429);
        expect(limited.body.error.code).toBe("HANDOFF_EXPORT_RATE_LIMITED");
      }
      expect(m.exportDocument).not.toHaveBeenCalled();
    } finally {
      delete process.env.HANDOFF_EXPORT_LIMIT_MAX;
    }
  });

  it("loads the change request for the caller, from the run they may read", async () => {
    await request(app).get("/impact-analyses/ia-1/export?format=pdf");
    const [passed, reader] = m.loadHandoffChangeRequest.mock.calls[0]!;
    expect(passed).toMatchObject({ id: "ia-1", sourceAnalysisId: "cr-1" });
    expect(typeof reader).toBe("function");
  });

  it("states a run without a change request from the run alone", async () => {
    m.loadHandoffChangeRequest.mockResolvedValue(null);
    await request(app).get("/impact-analyses/ia-1/export?format=docx");
    const { markdown, title } = exported();
    expect(title).toBe("Impact analysis ia-1 - hand-off");
    expect(markdown).not.toContain("## Requirements");
  });

  it("includes the run's own answered questions when its document is readable", async () => {
    m.readSubjectDialog.mockResolvedValue({
      projectId: "project-001",
      documentId: "doc-1",
      requirements: {
        requirements: [{ id: "T1", title: "Reading time" }],
        totalAmbiguities: 0,
        totalEvidenceNeeds: 0,
      },
      state: {
        analysisId: "ia-1",
        currentRound: 1,
        maxRounds: 3,
        resolvedAmbiguities: [],
        rounds: [
          {
            round: 1,
            questions: [
              {
                id: "q1",
                requirementId: "T1",
                ambiguityField: "R7",
                question: "Minutes or seconds?",
                context: "",
                answer: "Minutes",
              },
            ],
            answers: [],
          },
        ],
      },
    });
    await request(app).get("/impact-analyses/ia-1/export?format=docx");
    expect(m.readSubjectDialog).toHaveBeenCalledWith({ kind: "impact", id: "ia-1" });
    expect(exported().markdown).toContain("- **Minutes or seconds?** (Reading time)\n  - Minutes");
  });

  it("leaves the run's answers out when the caller cannot see its document", async () => {
    m.readSubjectDialog.mockResolvedValue({
      projectId: "project-001",
      documentId: "doc-1",
      requirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
      state: {
        analysisId: "ia-1",
        currentRound: 1,
        maxRounds: 3,
        resolvedAmbiguities: [],
        rounds: [
          {
            round: 1,
            questions: [
              {
                id: "q1",
                requirementId: "T1",
                ambiguityField: "R7",
                question: "Secret question?",
                context: "",
                answer: "Secret answer",
              },
            ],
            answers: [],
          },
        ],
      },
    });
    m.canSeeDocument.mockResolvedValue(false);
    const res = await request(app).get("/impact-analyses/ia-1/export?format=docx");
    expect(res.status).toBe(200);
    expect(exported().markdown).not.toContain("Secret");
  });

  it.each([[""], ["?format=md"], ["?format=html"], ["?format=docx&format=pdf"]])(
    "refuses any format but docx or pdf (%s)",
    async (query) => {
      const res = await request(app).get(`/impact-analyses/ia-1/export${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_FORMAT");
      expect(m.getImpactAnalysisDetail).not.toHaveBeenCalled();
      expect(m.exportDocument).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for an unknown run", async () => {
    m.getImpactAnalysisDetail.mockResolvedValue(null);
    const res = await request(app).get("/impact-analyses/missing/export?format=pdf");
    expect(res.status).toBe(404);
    expect(m.exportDocument).not.toHaveBeenCalled();
  });

  it("answers 404 when the caller cannot read every project of the run", async () => {
    m.getImpactAnalysisDetail.mockResolvedValue({
      ...detail,
      projectIds: ["project-001", "project-002"],
    });
    const res = await request(app).get("/impact-analyses/ia-1/export?format=pdf");
    expect(res.status).toBe(404);
    expect(m.loadHandoffChangeRequest).not.toHaveBeenCalled();
    expect(m.exportDocument).not.toHaveBeenCalled();
  });

  it("answers 403 without analysis.read", async () => {
    m.permitRead = false;
    const res = await request(app).get("/impact-analyses/ia-1/export?format=pdf");
    expect(res.status).toBe(403);
    expect(m.exportDocument).not.toHaveBeenCalled();
  });
});
