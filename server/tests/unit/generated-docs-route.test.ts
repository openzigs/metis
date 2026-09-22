/**
 * Tests for Epic #486 / Issue #487 — Generated Docs API routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock dependencies
vi.mock("../../src/lib/prisma.js", () => ({
  Prisma: {
    DbNull: Symbol("DbNull"),
  },
  prisma: {
    project: {
      findFirst: vi.fn(),
      // #619 — approval gate off by default; gated-export cases flip this.
      findUnique: vi.fn(async () => ({ requireApprovedReview: false })),
    },
    generatedDocument: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async ({ data }) => {
        const doc = await prisma.generatedDocument.findFirst({} as never);
        if (doc) Object.assign(doc, data);
        await prisma.generatedDocument.update({ data } as never);
        return { count: 1 };
      }),
    },
    generatedDocumentVersion: { findFirst: vi.fn(), create: vi.fn() },
    task: {
      upsert: vi.fn(async ({ create }) => create),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (fn) => fn(prisma)),
    reviewRequestItem: { findMany: vi.fn(async () => []) },
    codeSymbol: { findMany: vi.fn().mockResolvedValue([]) },
    knowledgeChunk: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    document: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
  },
}));

vi.mock("../../src/lib/docs-gen/generation-inputs.js", () => ({
  captureGenerationInputs: vi.fn(async () => ({ version: 1, fingerprint: "snapshot", items: {} })),
}));

vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  // #674 — the docs router now runs the `requireProjectAccess` chokepoint, which
  // needs an authenticated user. An `admin` bypasses the workspace lookup so
  // these tests keep asserting handler behaviour without a project.findUnique
  // interaction (previously this mock set no user → the chokepoint 401'd).
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: "user_admin", username: "admin", role: "admin", permissions: [] };
    next();
  },
  refreshAuthenticatedUser: (
    req: {
      user?: {
        userId: string;
        username: string;
        role: string;
        permissions: unknown[];
        workspaces?: string[];
      };
    },
    _res: unknown,
    next: () => void,
  ) => {
    if (req.user) {
      req.user.workspaces = ["w1"];
    }
    next();
  },
}));

vi.mock("../../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../src/lib/docs-gen/discovery-agent.js", () => ({
  DISCOVERY_SUMMARY_PROMPT_VERSION: 1,
  resolveDiscoveryGenerationModel: vi.fn().mockReturnValue("discovery-test-model"),
  runDiscoveryAgent: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/docs-gen/assembler.js", () => ({
  assembleDocument: vi.fn().mockReturnValue("# Test Doc\n\nContent here"),
}));

vi.mock("../../src/lib/docs-gen/generated-doc-publication.js", () => ({
  GENERATED_DOC_PUBLICATION_TASK_TYPE: "publish-generated-document",
  enqueueGeneratedDocPublication: vi.fn().mockResolvedValue({
    revisionId: "rev-1",
    syntheticDocumentId: "gendoc-doc-1",
  }),
  enqueueGeneratedDocDeletion: vi.fn().mockResolvedValue({
    revisionId: "gendoc:proj-1:doc-1:v3",
    syntheticDocumentId: "gendoc-doc-1",
  }),
  generatedDocSyntheticDocumentId: vi.fn(
    (generatedDocumentId: string, revisionId?: string | null) =>
      `gendoc-${generatedDocumentId}${revisionId ? `:${revisionId}` : ""}`,
  ),
}));

vi.mock("../../src/lib/docs-gen/evidence-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/docs-gen/evidence-policy.js")>();
  return {
    ...actual,
    resolveEvidencePolicy: vi.fn(),
    requireRepositoryGraph: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/docs-gen/grounding/grounding-retrieval.js", () => ({
  buildProjectGroundingContext: vi.fn(),
  buildSectionGroundingRetriever: vi.fn(),
}));

vi.mock("../../src/lib/docs-gen/holistic-synthesizer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/docs-gen/holistic-synthesizer.js")>();
  return {
    ...actual,
    buildDocsGenProvider: vi.fn(() => ({ tuning: { phase1Model: "phase1-test" } })),
    resolvePhase2Router: vi.fn(() => ({
      primary: {
        tuning: {
          phase2Model: "phase2-test",
          claimModel: "claim-test",
          judgeModel: "judge-test",
        },
      },
      hybrid: null,
    })),
    synthesizeHolisticDocument: vi.fn(),
  };
});

vi.mock("../../src/lib/docs-gen/db-schema-synthesizer.js", () => ({
  DB_SCHEMA_PROSE_PROMPT_VERSION: 1,
  synthesizeDbSchemaDocument: vi.fn(),
}));

vi.mock("../../src/lib/docs-gen/grounding/domain-web-research.js", () => ({
  runDomainWebResearch: vi.fn(),
}));

vi.mock("../../src/lib/docs-gen/grounding/degraded-warnings.js", () => ({
  deriveDocStatus: vi.fn((warnings: unknown[]) => (warnings.length > 0 ? "degraded" : "ready")),
}));

vi.mock("../../src/lib/socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    docSection: vi.fn(),
  },
  genericFailureMessage: () => "Generation failed",
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

import { generatedDocsRouter } from "../../src/routes/generated-docs.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  graphFingerprintOf,
  generatedDocRevisionId,
  legacyGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "../../src/lib/docs-gen/generated-doc-provenance.js";
import { generateDocumentAsync } from "../../src/routes/generated-docs.js";
import {
  resolveEvidencePolicy,
  requireRepositoryGraph,
} from "../../src/lib/docs-gen/evidence-policy.js";
import {
  buildProjectGroundingContext,
  buildSectionGroundingRetriever,
} from "../../src/lib/docs-gen/grounding/grounding-retrieval.js";
import { synthesizeHolisticDocument } from "../../src/lib/docs-gen/holistic-synthesizer.js";
import { synthesizeDbSchemaDocument } from "../../src/lib/docs-gen/db-schema-synthesizer.js";
import { runDomainWebResearch } from "../../src/lib/docs-gen/grounding/domain-web-research.js";
import { jobEvents } from "../../src/lib/socket/job-events.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/docs", generatedDocsRouter());
  // Error handler
  app.use(
    (
      err: {
        statusCode?: number;
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      },
      _req: unknown,
      res: express.Response,
      _next: unknown,
    ) => {
      res
        .status(err.statusCode ?? 500)
        .json({ error: { code: err.code, message: err.message, details: err.details } });
    },
  );
  return app;
}

describe("generated-docs routes", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    // #619 — restore the default (gate off) implementations that gate tests
    // override with mockResolvedValue/mockRejectedValue.
    (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      requireApprovedReview: false,
    }));
    (prisma.reviewRequestItem.findMany as ReturnType<typeof vi.fn>).mockImplementation(
      async () => [],
    );
    (prisma.generatedDocumentVersion.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (resolveEvidencePolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      actor: { userId: "user_admin", role: "admin" },
      sharedDocumentIds: [],
      allowWebResearch: false,
    });
    (buildProjectGroundingContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      sources: [],
      sourceIds: new Set(),
      isEmpty: true,
    });
    (buildSectionGroundingRetriever as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (synthesizeHolisticDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      markdown: "# Synthesized",
      warnings: [],
      provenanceManifest: null,
    });
    (synthesizeDbSchemaDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      markdown: "# Schema",
      schemaGraph: null,
      generationModel: "db-schema-test-model",
      warnings: [],
    });
  });

  describe("generateDocumentAsync", () => {
    it("falls back to an empty scope filter when stored JSON is malformed", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: "Broken Filter Doc",
        scope: "full",
        scopeFilter: "{not-json",
        evidencePolicy: "{}",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.codeSymbol.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await generateDocumentAsync("doc-1", "proj-1");

      expect(synthesizeHolisticDocument).toHaveBeenCalledWith(
        "proj-1",
        "business-requirements",
        "Broken Filter Doc",
        expect.objectContaining({ groundingForSection: expect.any(Function) }),
      );
      const versionCreate = (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>)
        .mock.calls.length;
      expect(versionCreate).toBeGreaterThanOrEqual(1);
    });

    it("runs best-effort domain web research and still generates when the web augmentation fails", async () => {
      (resolveEvidencePolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        actor: { userId: "user_admin", role: "admin" },
        sharedDocumentIds: [],
        allowWebResearch: true,
        repoConnectorId: "repo-a",
        codeGraphId: "graph-a",
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: "Arch",
        scope: "repository",
        scopeFilter: JSON.stringify({ docType: "architecture" }),
        evidencePolicy: "{}",
      });
      (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        name: "Proj",
        description: "Desc",
        requireApprovedReview: false,
      });
      (runDomainWebResearch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("web down"));
      (buildProjectGroundingContext as ReturnType<typeof vi.fn>).mockResolvedValue({
        sources: [
          {
            sourceId: "rag:doc:c1",
            kind: "rag",
            label: "src/a.ts",
            text: "evidence",
          },
        ],
        sourceIds: new Set(["rag:doc:c1"]),
        isEmpty: false,
      });
      (synthesizeHolisticDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
        markdown: "# Repo",
        warnings: [{ kind: "source-unavailable", severity: "warning", message: "warn" }],
        provenanceManifest: JSON.stringify({
          ...legacyGeneratedDocVersionManifest({
            projectId: "proj-1",
            generatedDocumentId: "doc-1",
            version: 2,
          }),
          document: {
            title: "Arch",
            scope: "repository",
            docType: "architecture",
            generatedAt: new Date(0).toISOString(),
          },
          policy: {
            repoConnectorId: "repo-a",
            codeGraphId: "graph-a",
            sharedDocumentIds: [],
            allowWebResearch: true,
          },
          sections: [
            {
              sectionLabel: "Overview",
              sectionIndex: 0,
              sectionSlug: "overview",
              providerKind: "bedrock",
              model: "phase2-test",
              factsSourceIds: [],
              groundingSourceIds: ["rag:doc:c1"],
            },
          ],
        }),
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 1,
      });
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.codeSymbol.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { contentHash: "abc", qualifiedName: "Q" },
      ]);

      await generateDocumentAsync("doc-1", "proj-1");

      expect(runDomainWebResearch).toHaveBeenCalled();
      expect(synthesizeHolisticDocument).toHaveBeenCalledWith(
        "proj-1",
        "architecture",
        "Arch",
        expect.objectContaining({ repoConnectorId: "repo-a", grounding: expect.any(Object) }),
      );
      expect(prisma.generatedDocument.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "degraded", errorMessage: null }),
        }),
      );
      expect(jobEvents.completed).toHaveBeenCalledWith(
        "doc-generation",
        "doc-1",
        "proj-1",
        "Generated with warnings",
      );
    });

    it("does not mutate a missing or deleted document", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await generateDocumentAsync("missing", "proj-1");

      expect(prisma.generatedDocument.update).not.toHaveBeenCalled();
      expect(jobEvents.failed).not.toHaveBeenCalled();
    });

    it("falls back to discovery assembly for non-holistic scopes", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: "Module Doc",
        scope: "module",
        scopeFilter: "{}",
        evidencePolicy: "{}",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.codeSymbol.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await generateDocumentAsync("doc-1", "proj-1");

      expect(synthesizeHolisticDocument).not.toHaveBeenCalled();
      expect(synthesizeDbSchemaDocument).not.toHaveBeenCalled();
      const createArg = (prisma.generatedDocumentVersion.create as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as {
        data: { provenanceManifest: string };
      };
      expect(parseGeneratedDocVersionManifest(createArg.data.provenanceManifest)).toMatchObject({
        graphFingerprint: {
          algorithm: "sha256",
          status: "available",
          fingerprint: graphFingerprintOf([]),
        },
        generation: {
          pipeline: "discovery-agent",
          model: {
            phase1: { model: "not-applicable" },
            phase2: { model: "discovery-test-model" },
            claim: { model: "not-applicable" },
            judge: { model: "not-applicable" },
          },
          prompts: { phase1: { version: 1 }, phase2: { mode: "single" } },
        },
      });
    });

    it("persists publication in the version transaction before completing generation", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: "Doc",
        scope: "full",
        scopeFilter: JSON.stringify({ docType: "user-guide" }),
        evidencePolicy: "{}",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.codeSymbol.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await generateDocumentAsync("doc-1", "proj-1");

      expect(prisma.task.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            projectId: "proj-1",
            createdById: "user_admin",
            payload: JSON.stringify({
              projectId: "proj-1",
              generatedDocumentId: "doc-1",
              version: 1,
              revisionId: "gendoc:proj-1:doc-1:v1",
            }),
          }),
        }),
      );
      expect(prisma.generatedDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
      );
      expect(jobEvents.completed).toHaveBeenCalledWith(
        "doc-generation",
        "doc-1",
        "proj-1",
        "Documentation ready",
      );
    });

    it("uses safe fallbacks for web research and grounding inputs when optional values are missing", async () => {
      (resolveEvidencePolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        actor: { userId: "user_admin", role: "admin" },
        sharedDocumentIds: [],
        allowWebResearch: true,
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: null,
        scope: "full",
        scopeFilter: JSON.stringify({ docType: "user-guide" }),
        evidencePolicy: "{}",
      });
      (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (runDomainWebResearch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (buildProjectGroundingContext as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (synthesizeHolisticDocument as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _projectId: string,
          _docType: string,
          _title: string,
          options: {
            onSectionProgress?: (update: {
              section: string;
              status: string;
              index: number;
              total: number;
              warning?: { kind: string; severity: string; message: string };
            }) => void;
          },
        ) => {
          options.onSectionProgress?.({
            section: "Overview",
            status: "done",
            index: 1,
            total: 1,
          });
          return {
            markdown: "# User Guide",
            warnings: [],
            provenanceManifest: JSON.stringify({
              ...legacyGeneratedDocVersionManifest({
                projectId: "proj-1",
                generatedDocumentId: "doc-1",
                version: 1,
              }),
              document: {
                title: "Generated Documentation",
                scope: "full",
                docType: "user-guide",
                generatedAt: new Date(0).toISOString(),
              },
              policy: { sharedDocumentIds: [], allowWebResearch: true },
            }),
          };
        },
      );
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.codeSymbol.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await generateDocumentAsync("doc-1", "proj-1");

      expect(runDomainWebResearch).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: "Project",
          projectDescription: null,
          docTitle: "user guide",
        }),
        expect.any(Object),
      );
      expect(synthesizeHolisticDocument).toHaveBeenCalledWith(
        "proj-1",
        "user-guide",
        "Generated Documentation",
        expect.not.objectContaining({
          grounding: expect.anything(),
          repoConnectorId: expect.anything(),
        }),
      );
      expect(jobEvents.docSection).toHaveBeenCalledWith(
        expect.objectContaining({ warning: undefined }),
      );
    });

    it("uses database-scope fallbacks when the stored filter is unusable", async () => {
      (resolveEvidencePolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        actor: { userId: "user_admin", role: "admin" },
        sharedDocumentIds: [],
        allowWebResearch: false,
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: "Stored DB Doc",
        scope: "database",
        scopeFilter: "{broken-json",
        evidencePolicy: "{}",
      });
      (synthesizeDbSchemaDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
        markdown: "# Schema",
        schemaGraph: { tables: [] },
        generationModel: "db-schema-test-model",
        warnings: [],
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.codeSymbol.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await generateDocumentAsync("doc-1", "proj-1");

      expect(synthesizeDbSchemaDocument).toHaveBeenCalledWith(
        "proj-1",
        "",
        "user_admin",
        "Stored DB Doc",
      );
      const createArg = (prisma.generatedDocumentVersion.create as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as {
        data: { provenanceManifest: string };
      };
      expect(parseGeneratedDocVersionManifest(createArg.data.provenanceManifest)).toMatchObject({
        graphFingerprint: {
          algorithm: "sha256",
          status: "available",
          fingerprint: expect.any(String),
        },
        generation: {
          pipeline: "database-schema",
          model: {
            phase1: { model: "not-applicable" },
            phase2: { model: "db-schema-test-model" },
            claim: { model: "not-applicable" },
            judge: { model: "not-applicable" },
          },
          prompts: { phase1: { version: 1 }, phase2: { mode: "single" } },
        },
        sourceFingerprints: [
          expect.objectContaining({ kind: "database-schema", dbConnectorId: null }),
        ],
      });
      expect(prisma.generatedDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schemaGraph: JSON.stringify({ tables: [] }) }),
        }),
      );
    });
  });

  describe("DELETE /:docId", () => {
    it("enqueues exact cleanup for legacy versions whose revisionId is still null", async () => {
      const deletedDoc = {
        id: "doc-1",
        projectId: "proj-1",
        deletedAt: null,
      };
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(deletedDoc)
        .mockResolvedValueOnce(deletedDoc);
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ version: 3, revisionId: null, provenanceManifest: null })
        .mockResolvedValueOnce({ version: 2, revisionId: null, provenanceManifest: null })
        .mockResolvedValueOnce(null);

      const response = await request(app).delete("/projects/proj-1/docs/doc-1");

      expect(response.status).toBe(204);
      expect(prisma.task.upsert).toHaveBeenCalledTimes(2);
      const payloads = vi
        .mocked(prisma.task.upsert)
        .mock.calls.map(([input]) => JSON.parse(input.create.payload as string));
      expect(payloads[0]).toEqual({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        version: 3,
        revisionId: generatedDocRevisionId({
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 3,
        }),
      });
      expect(payloads[1]).toEqual({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        version: 2,
        revisionId: generatedDocRevisionId({
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 2,
        }),
      });
      for (const [input] of vi.mocked(prisma.task.upsert).mock.calls)
        expect(input.create.createdById).toBe("user_admin");
    });
  });

  describe("POST /projects/:projectId/docs/generate", () => {
    it("returns 202 and creates a document", async () => {
      (prisma.project.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "proj-1" });
      (prisma.generatedDocument.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        title: "Test Doc",
        status: "pending",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );

      const res = await request(app)
        .post("/projects/proj-1/docs/generate")
        .send({
          title: "Test Doc",
          scope: "full",
          scopeFilter: {
            actorId: "attacker",
            evidencePolicy: { principal: { userId: "attacker" } },
          },
          sharedReferenceDocumentIds: ["ref-1"],
        });

      expect(res.status).toBe(202);
      expect(res.body.data.id).toBe("doc-1");
      expect(prisma.generatedDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: "Test Doc", scope: "full" }),
        }),
      );
      const data = vi.mocked(prisma.generatedDocument.create).mock.calls[0][0].data;
      expect(JSON.parse(data.evidencePolicy as string)).toEqual({
        version: 1,
        principal: { kind: "initiating-user", userId: "user_admin", role: "admin" },
        sharedDocumentIds: ["ref-1"],
        allowWebResearch: false,
      });
    });

    it("defaults groundDomainWithWebResearch to false in scopeFilter (no surprise web calls) (#283)", async () => {
      (prisma.project.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "proj-1" });
      (prisma.generatedDocument.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-2",
        projectId: "proj-1",
        status: "pending",
      });

      const res = await request(app)
        .post("/projects/proj-1/docs/generate")
        .send({ title: "Doc", scope: "full" });

      expect(res.status).toBe(202);
      const created = (prisma.generatedDocument.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { data: { scopeFilter: string } };
      const filter = JSON.parse(created.data.scopeFilter) as {
        groundDomainWithWebResearch?: boolean;
      };
      expect(filter.groundDomainWithWebResearch).toBe(false);
    });

    it("persists groundDomainWithWebResearch=true when opted in (#283)", async () => {
      (prisma.project.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "proj-1" });
      (prisma.generatedDocument.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-3",
        projectId: "proj-1",
        status: "pending",
      });

      const res = await request(app)
        .post("/projects/proj-1/docs/generate")
        .send({ title: "Doc", scope: "full", groundDomainWithWebResearch: true });

      expect(res.status).toBe(202);
      const created = (prisma.generatedDocument.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { data: { scopeFilter: string } };
      const filter = JSON.parse(created.data.scopeFilter) as {
        groundDomainWithWebResearch?: boolean;
      };
      expect(filter.groundDomainWithWebResearch).toBe(true);
      expect(
        JSON.parse(
          vi.mocked(prisma.generatedDocument.create).mock.calls[0][0].data.evidencePolicy as string,
        ).allowWebResearch,
      ).toBe(true);
    });

    it("returns 400 for invalid body", async () => {
      const res = await request(app).post("/projects/proj-1/docs/generate").send({ title: "" });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent project", async () => {
      (prisma.project.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app).post("/projects/proj-1/docs/generate").send({ title: "Doc" });

      expect(res.status).toBe(404);
    });

    it("returns 400 when repository scope omits repoConnectorId", async () => {
      const res = await request(app)
        .post("/projects/proj-1/docs/generate")
        .send({ title: "Repo Doc", scope: "repository", scopeFilter: {} });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when database scope omits dbConnectorId", async () => {
      const res = await request(app)
        .post("/projects/proj-1/docs/generate")
        .send({ title: "DB Doc", scope: "database", scopeFilter: {} });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("checks repository access before creating a repository-scoped document", async () => {
      (prisma.project.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "proj-1" });
      (prisma.generatedDocument.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-repo",
        projectId: "proj-1",
        status: "pending",
      });

      const res = await request(app)
        .post("/projects/proj-1/docs/generate")
        .send({ title: "Repo", scope: "repository", scopeFilter: { repoConnectorId: "repo-1" } });

      expect(res.status).toBe(202);
      expect(requireRepositoryGraph).toHaveBeenCalledWith("proj-1", "repo-1");
    });
  });

  describe("GET /projects/:projectId/docs", () => {
    it("retains legacy shared-ID indexing health until the first revision-owned publication", async () => {
      vi.mocked(prisma.generatedDocument.findMany).mockResolvedValue([
        { id: "doc-1", versions: [{ revisionId: "revision-2" }] },
      ] as never);
      vi.mocked(prisma.document.findMany).mockResolvedValue([
        { id: "gendoc-doc-1", indexState: "indexed", status: "ready", chunkCount: 2 },
      ] as never);
      const res = await request(app).get("/projects/proj-1/docs");
      expect(res.status).toBe(200);
      expect(res.body.data[0].indexing).toMatchObject({ state: "indexed", chunkCount: 2 });
    });
    it("returns list of documents with separate indexing health", async () => {
      (prisma.generatedDocument.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "doc-1", title: "Doc 1", status: "ready", versions: [{ revisionId: "revision-2" }] },
      ]);
      (prisma.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "gendoc-doc-1:revision-2",
          indexState: "indexed",
          status: "ready",
          chunkCount: 7,
          errorMessage: null,
          processedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]);

      const res = await request(app).get("/projects/proj-1/docs");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe("Doc 1");
      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            projectId: "proj-1",
            id: { in: ["gendoc-doc-1:revision-2", "gendoc-doc-1"] },
            deletedAt: null,
          },
        }),
      );
      expect(res.body.data[0].indexing).toEqual({
        state: "indexed",
        status: "ready",
        chunkCount: 7,
        errorMessage: null,
        processedAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  describe("GET /projects/:projectId/docs/:docId", () => {
    it("falls back to legacy indexing health only when the revision-owned row is absent", async () => {
      vi.mocked(prisma.generatedDocument.findFirst).mockResolvedValue({
        id: "doc-1",
        versions: [
          {
            id: "v1",
            documentId: "doc-1",
            version: 1,
            revisionId: "revision-1",
            provenanceManifest: null,
          },
        ],
      } as never);
      vi.mocked(prisma.document.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          indexState: "indexed",
          status: "ready",
          chunkCount: 2,
        } as never);
      const res = await request(app).get("/projects/proj-1/docs/doc-1");
      expect(res.status).toBe(200);
      expect(res.body.data.indexing).toMatchObject({ state: "indexed", chunkCount: 2 });
      expect(prisma.document.findFirst).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { id: "gendoc-doc-1:revision-1", projectId: "proj-1", deletedAt: null },
        }),
      );
      expect(prisma.document.findFirst).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { id: "gendoc-doc-1", projectId: "proj-1", deletedAt: null },
        }),
      );
    });
    it("returns document with versions and separate indexing health", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "Doc",
        content: "# Hello",
        versions: [
          { id: "v1", documentId: "doc-1", version: 1, revisionId: null, provenanceManifest: null },
        ],
      });
      (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        indexState: "pending",
        status: "processing",
        chunkCount: 0,
        errorMessage: null,
        processedAt: null,
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1");

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe("# Hello");
      expect(res.body.data.indexing).toEqual({
        state: "pending",
        status: "processing",
        chunkCount: 0,
        errorMessage: null,
        processedAt: null,
      });
      expect(res.body.data.versions[0].revisionId).toBe(
        generatedDocRevisionId({
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 1,
        }),
      );
      expect(
        parseGeneratedDocVersionManifest(res.body.data.versions[0].provenanceManifest),
      ).toMatchObject({
        historicalCitations: { status: "unknown", mode: "legacy-unknown" },
        legacy: { historicalCitations: "legacy-unknown" },
      });
    });

    it("preserves immutable stored provenance for versioned rows", async () => {
      const manifest = JSON.stringify({
        schemaVersion: 1,
        revision: {
          revisionId: generatedDocRevisionId({
            projectId: "proj-1",
            generatedDocumentId: "doc-1",
            version: 2,
          }),
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 2,
        },
        document: {
          title: "Doc",
          scope: "full",
          docType: null,
          generatedAt: new Date(0).toISOString(),
        },
        policy: { sharedDocumentIds: [], allowWebResearch: false },
        generation: {
          pipeline: "holistic",
          model: {
            phase1: { model: "a" },
            phase2: { model: "b" },
            claim: { model: "c" },
            judge: { model: "d" },
          },
          prompts: { phase1: { version: 1 }, phase2: { mode: "single" } },
        },
        graphFingerprint: {
          algorithm: "sha256",
          fingerprint: graphFingerprintOf([]),
        },
        sourceFingerprints: [],
        selectedEvidence: { primary: [] },
        sections: [],
        historicalCitations: { status: "unavailable", mode: "not-retained" },
        legacy: { historicalCitations: "not-retained" },
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "Doc",
        content: "# Hello",
        versions: [
          {
            id: "v2",
            documentId: "doc-1",
            version: 2,
            revisionId: generatedDocRevisionId({
              projectId: "proj-1",
              generatedDocumentId: "doc-1",
              version: 2,
            }),
            provenanceManifest: manifest,
          },
        ],
      });
      (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        indexState: "indexed",
        status: "ready",
        chunkCount: 2,
        errorMessage: null,
        processedAt: new Date("2026-01-02T00:00:00.000Z"),
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body.data.versions[0].provenanceManifest)).toEqual({
        ...JSON.parse(manifest),
        graphFingerprint: {
          algorithm: "sha256",
          status: "available",
          fingerprint: graphFingerprintOf([]),
        },
      });
    });

    it("keeps pre-pipeline schema-version-1 manifests readable", async () => {
      const manifest = JSON.stringify({
        schemaVersion: 1,
        revision: {
          revisionId: generatedDocRevisionId({
            projectId: "proj-1",
            generatedDocumentId: "doc-1",
            version: 2,
          }),
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 2,
        },
        document: {
          title: "Doc",
          scope: "full",
          docType: null,
          generatedAt: new Date(0).toISOString(),
        },
        policy: { sharedDocumentIds: [], allowWebResearch: false },
        generation: {
          model: {
            phase1: { model: "a" },
            phase2: { model: "b" },
            claim: { model: "c" },
            judge: { model: "d" },
          },
          prompts: { phase1: { version: 1 }, phase2: { mode: "single" } },
        },
        sourceFingerprints: [],
        selectedEvidence: { primary: [] },
        sections: [],
        historicalCitations: { status: "unavailable", mode: "legacy-unknown" },
        legacy: { historicalCitations: "legacy-unknown" },
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "Doc",
        content: "# Hello",
        versions: [
          {
            id: "v2",
            documentId: "doc-1",
            version: 2,
            revisionId: generatedDocRevisionId({
              projectId: "proj-1",
              generatedDocumentId: "doc-1",
              version: 2,
            }),
            provenanceManifest: manifest,
          },
        ],
      });
      (prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        indexState: "indexed",
        status: "ready",
        chunkCount: 2,
        errorMessage: null,
        processedAt: new Date("2026-01-02T00:00:00.000Z"),
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body.data.versions[0].provenanceManifest)).toMatchObject({
        generation: { pipeline: "holistic" },
      });
    });

    it("returns 404 for missing doc", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app).get("/projects/proj-1/docs/missing");

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /projects/:projectId/docs/:docId", () => {
    it("updates document metadata", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
      });
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "Updated Title",
        autoUpdate: true,
      });

      const res = await request(app)
        .patch("/projects/proj-1/docs/doc-1")
        .send({ title: "Updated Title", autoUpdate: true });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("Updated Title");
    });

    it("#52 — never returns a failed document's raw error text", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
      });
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "Doc",
        status: "failed",
        autoUpdate: false,
        errorMessage: "Error: secret detail at /srv/metis/server/src/x.ts",
      });

      const res = await request(app)
        .patch("/projects/proj-1/docs/doc-1")
        .send({ autoUpdate: false });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("failed");
      expect(res.body.data.errorMessage).toMatch(/^Document generation failed\./);
      expect(JSON.stringify(res.body)).not.toContain("secret detail");
    });

    it("returns 400 for an invalid patch body", async () => {
      const res = await request(app).patch("/projects/proj-1/docs/doc-1").send({ title: "" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 404 when updating a missing document", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app)
        .patch("/projects/proj-1/docs/missing")
        .send({ title: "Updated Title" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DOC_NOT_FOUND");
    });
  });

  describe("DELETE /projects/:projectId/docs/:docId", () => {
    it("soft-deletes a document", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        scope: "full",
        scopeFilter: "{}",
        evidencePolicy: "{}",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          version: 3,
          revisionId: "gendoc:proj-1:doc-1:v3",
        })
        .mockResolvedValueOnce(null);
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
      });

      const res = await request(app).delete("/projects/proj-1/docs/doc-1");

      expect(res.status).toBe(204);
      expect(prisma.generatedDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(
        JSON.parse(vi.mocked(prisma.task.upsert).mock.calls[0][0].create.payload as string),
      ).toEqual({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        version: 3,
        revisionId: "gendoc:proj-1:doc-1:v3",
      });
    });

    it("enqueues cleanup for every persisted revision so deletion does not depend on the original actor remaining active", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        scope: "full",
        scopeFilter: "{}",
        evidencePolicy: "{}",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ version: 4, revisionId: "gendoc:proj-1:doc-1:v4" })
        .mockResolvedValueOnce({ version: 3, revisionId: "gendoc:proj-1:doc-1:v3" })
        .mockResolvedValueOnce(null);
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
      });

      const res = await request(app).delete("/projects/proj-1/docs/doc-1");

      expect(res.status).toBe(204);
      expect(prisma.task.upsert).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(prisma.task.upsert)
          .mock.calls.map(([input]) => JSON.parse(input.create.payload as string)),
      ).toEqual([
        {
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 4,
          revisionId: "gendoc:proj-1:doc-1:v4",
        },
        {
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 3,
          revisionId: "gendoc:proj-1:doc-1:v3",
        },
      ]);
    });

    it("persists legacy shared-ID cleanup even without version history", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        scope: "full",
        scopeFilter: "{}",
        evidencePolicy: "{}",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      (prisma.generatedDocument.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
      });

      const res = await request(app).delete("/projects/proj-1/docs/doc-1");

      expect(res.status).toBe(204);
      expect(prisma.task.upsert).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(vi.mocked(prisma.task.upsert).mock.calls[0][0].create.payload as string),
      ).toEqual({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        version: 1,
        revisionId: "gendoc:proj-1:doc-1:v1",
      });
    });

    it("returns 404 for non-existent doc", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app).delete("/projects/proj-1/docs/missing");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /projects/:projectId/docs/:docId/export", () => {
    const markdown = "# Doc Title\n\nSome **content** here.\n";

    it("exports markdown as a .md download with the doc's content", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "My Doc",
        content: markdown,
        status: "ready",
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1/export?format=markdown");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.headers["content-disposition"]).toContain(".md");
      expect(res.text).toBe(markdown);
    });

    it("exports markdown for a degraded doc (same gating as pdf/docx)", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-2",
        title: "Degraded Doc",
        content: markdown,
        status: "degraded",
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-2/export?format=markdown");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.text).toBe(markdown);
      // The query must permit both `ready` and `degraded` statuses.
      expect(prisma.generatedDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ["ready", "degraded"] } }),
        }),
      );
    });

    it("returns 400 for an invalid format", async () => {
      const res = await request(app).get("/projects/proj-1/docs/doc-1/export?format=xml");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_FORMAT");
    });

    it("returns 404 when the document is missing or not ready", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app).get("/projects/proj-1/docs/missing/export?format=markdown");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DOC_NOT_FOUND");
    });

    // ---- #619 — approval gate on spec export ------------------------------

    it("blocks export with 409 APPROVAL_REQUIRED when the gate is on and no approved review exists", async () => {
      (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireApprovedReview: true,
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "My Doc",
        content: markdown,
        status: "ready",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 2,
      });
      (prisma.reviewRequestItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const res = await request(app).get("/projects/proj-1/docs/doc-1/export?format=markdown");

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
      expect(res.body.error.details.documentIds).toEqual(["doc-1"]);
    });

    it("blocks export when the only approval is STALE (pinned v1, doc now v2)", async () => {
      (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireApprovedReview: true,
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "My Doc",
        content: markdown,
        status: "ready",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 2,
      });
      (prisma.reviewRequestItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { pinnedVersion: 1 },
      ]);

      const res = await request(app).get("/projects/proj-1/docs/doc-1/export?format=markdown");

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
    });

    it("allows export when an approved review pins the current version", async () => {
      (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireApprovedReview: true,
      });
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "My Doc",
        content: markdown,
        status: "ready",
      });
      (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 2,
      });
      (prisma.reviewRequestItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { pinnedVersion: 2 },
      ]);

      const res = await request(app).get("/projects/proj-1/docs/doc-1/export?format=markdown");

      expect(res.status).toBe(200);
      expect(res.text).toBe(markdown);
    });

    it("FAIL CLOSED: a gate-check error blocks the export with 503", async () => {
      (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("db down"),
      );
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "doc-1",
        title: "My Doc",
        content: markdown,
        status: "ready",
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1/export?format=markdown");

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("APPROVAL_GATE_UNAVAILABLE");
    });
  });

  describe("GET /projects/:projectId/docs/:docId/schema-graph", () => {
    const graph = {
      tables: [
        {
          schema: "public",
          name: "users",
          description: "Stores user accounts.",
          columns: [
            {
              name: "id",
              dataType: "uuid",
              nullable: false,
              isPrimaryKey: true,
              isForeignKey: false,
            },
          ],
        },
      ],
      edges: [{ source: "orders", target: "users", columns: ["user_id"], refColumns: ["id"] }],
    };

    it("returns the parsed schema graph", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        schemaGraph: JSON.stringify(graph),
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1/schema-graph");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(graph);
      expect(prisma.generatedDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "doc-1", projectId: "proj-1", deletedAt: null }),
        }),
      );
    });

    it("returns 404 when the document does not exist", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app).get("/projects/proj-1/docs/missing/schema-graph");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DOC_NOT_FOUND");
    });

    it("returns 404 when the document has no schema graph", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        schemaGraph: null,
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1/schema-graph");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SCHEMA_GRAPH_NOT_FOUND");
    });

    it("returns 500 when the stored schema graph is corrupt", async () => {
      (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        schemaGraph: "{not valid json",
      });

      const res = await request(app).get("/projects/proj-1/docs/doc-1/schema-graph");

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("SCHEMA_GRAPH_CORRUPT");
    });
  });
});
