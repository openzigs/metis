/**
 * Generate route — path scope (`pathPrefixes`): body validation, the
 * fail-fast "matches nothing" check, the stored scope and title, and the
 * scope reaching grounding + synthesis. Mock setup mirrors
 * generated-docs-route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The caller each request authenticates as — admin by default; the
// object-level case below switches to a non-member reader.
const ADMIN = { userId: "user_admin", username: "admin", role: "admin", permissions: [] };
const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown> }));
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
    codeSymbol: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
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
    req.user = { ...auth.user };
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

// #67 — a PARTIAL mock: `deriveDocStatus` stays a spy these tests assert on,
// but every other export (notably `sectionFailedWarning`, which the read-path
// sanitiser builds its replacement message with) is the real, pure module.
// The previous whole-module stub exported only `deriveDocStatus`, so anything
// else the route reached for threw at request time.
vi.mock("../../src/lib/docs-gen/grounding/degraded-warnings.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/lib/docs-gen/grounding/degraded-warnings.js")
  >()),
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

import { generatedDocsRouter, generateDocumentAsync } from "../../src/routes/generated-docs.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  resolveEvidencePolicy,
  requireRepositoryGraph,
} from "../../src/lib/docs-gen/evidence-policy.js";
import {
  buildProjectGroundingContext,
  buildSectionGroundingRetriever,
} from "../../src/lib/docs-gen/grounding/grounding-retrieval.js";
import { synthesizeHolisticDocument } from "../../src/lib/docs-gen/holistic-synthesizer.js";
import { PathScopeEmptyError } from "../../src/lib/docs-gen/path-scope.js";
import { GENERATION_PATH_SCOPE_EMPTY_MESSAGE } from "../../src/lib/docs-gen/generation-failure-message.js";

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

const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

describe("POST /projects/:projectId/docs/generate — pathPrefixes", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = ADMIN;
    mocked(prisma.project.findFirst).mockResolvedValue({ id: "proj-1" });
    mocked(prisma.codeSymbol.findFirst).mockResolvedValue({ id: "sym-1" });
    mocked(prisma.generatedDocument.create).mockImplementation(async ({ data }) => ({
      id: "doc-1",
      ...data,
    }));
    // The fire-and-forget generation finds no document and returns quietly.
    mocked(prisma.generatedDocument.findFirst).mockResolvedValue(null);
    mocked(prisma.generatedDocumentVersion.findFirst).mockResolvedValue(null);
  });

  const post = (body: Record<string, unknown>) =>
    request(app)
      .post("/projects/proj-1/docs/generate")
      .send({ title: "BR", scope: "full", ...body });

  it("accepts good prefixes, normalises them and stores them in scopeFilter", async () => {
    const res = await post({ pathPrefixes: ["packages/fit/", "./packages\\domain/src"] });
    expect(res.status).toBe(202);
    const data = mocked(prisma.generatedDocument.create).mock.calls[0][0].data;
    expect(JSON.parse(data.scopeFilter).pathPrefixes).toEqual([
      "packages/fit",
      "packages/domain/src",
    ]);
    expect(data.title).toBe("BR [scope: packages/fit/, packages/domain/src/]");
  });

  it("checks for a match with a parameterised, segment-aware prefix query", async () => {
    await post({ pathPrefixes: ["packages/fit"] });
    expect(prisma.codeSymbol.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        OR: [{ filePath: "packages/fit" }, { filePath: { startsWith: "packages/fit/" } }],
      },
      select: { id: true },
    });
  });

  it("scopes the match check to the repository graph for repository scope", async () => {
    mocked(requireRepositoryGraph).mockResolvedValueOnce("graph-a");
    await post({
      scope: "repository",
      scopeFilter: { repoConnectorId: "repo-a" },
      pathPrefixes: ["packages/fit"],
    });
    expect(mocked(prisma.codeSymbol.findFirst).mock.calls[0][0].where.codeGraphId).toBe("graph-a");
  });

  it("leaves an unscoped request unchanged", async () => {
    const res = await post({});
    expect(res.status).toBe(202);
    const data = mocked(prisma.generatedDocument.create).mock.calls[0][0].data;
    expect(data.title).toBe("BR");
    expect(JSON.parse(data.scopeFilter)).not.toHaveProperty("pathPrefixes");
    expect(prisma.codeSymbol.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["traversal", ["../etc"]],
    ["nested traversal", ["packages/../../etc"]],
    ["absolute", ["/etc/passwd"]],
    ["drive letter", ["C:\\Windows"]],
    ["NUL", ["packages/fit\u0000"]],
    ["empty string", [""]],
    ["empty list", []],
    ["oversized list", Array.from({ length: 21 }, (_, i) => `p${i}/`)],
    ["over-long prefix", ["a".repeat(257)]],
    ["not an array", "packages/fit/"],
  ])("rejects %s with 400 and creates nothing", async (_label, pathPrefixes) => {
    const res = await post({ pathPrefixes });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
    expect(prisma.codeSymbol.findFirst).not.toHaveBeenCalled();
  });

  it("rejects pathPrefixes on a non-holistic scope", async () => {
    const res = await post({ scope: "module", pathPrefixes: ["packages/fit"] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("only supported when scope is 'full' or 'repository'");
  });

  it("rejects a scope smuggled inside scopeFilter", async () => {
    const res = await post({ scopeFilter: { pathPrefixes: ["../etc"] } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("top level");
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });

  it("404s a non-member before validating or probing the scope (object-level access)", async () => {
    auth.user = { userId: "u", username: "u", role: "reader", permissions: [] };
    mocked(prisma.project.findUnique).mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await post({ pathPrefixes: ["packages/fit/"] });
    expect(res.status).toBe(404);
    expect(prisma.codeSymbol.findFirst).not.toHaveBeenCalled();
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });

  it("returns a clear 400 when the prefixes match no indexed code", async () => {
    mocked(prisma.codeSymbol.findFirst).mockResolvedValue(null);
    const res = await post({ pathPrefixes: ["packages/nope/"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PATH_SCOPE_EMPTY");
    expect(res.body.error.message).toContain("packages/nope/");
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });
});

describe("generateDocumentAsync — stored path scope", () => {
  const scopedDoc = (scopeFilter: string) => ({
    id: "doc-1",
    projectId: "proj-1",
    title: "BR [scope: packages/fit/]",
    scope: "full",
    scopeFilter,
    evidencePolicy: "{}",
    updatedAt: new Date(0),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocked(resolveEvidencePolicy).mockResolvedValue({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      actor: { userId: "user_admin", role: "admin" },
      sharedDocumentIds: [],
      allowWebResearch: false,
    });
    mocked(buildProjectGroundingContext).mockResolvedValue({
      sources: [],
      sourceIds: new Set(),
      isEmpty: true,
    });
    mocked(buildSectionGroundingRetriever).mockReturnValue(vi.fn());
    mocked(synthesizeHolisticDocument).mockResolvedValue({
      markdown: "# Synthesized",
      warnings: [],
      provenanceManifest: null,
    });
    mocked(prisma.generatedDocumentVersion.findFirst).mockResolvedValue(null);
    mocked(prisma.generatedDocument.update).mockResolvedValue({});
    mocked(prisma.codeSymbol.findMany).mockResolvedValue([]);
  });

  it("passes the stored scope to synthesis and to both grounding retrievers", async () => {
    mocked(prisma.generatedDocument.findFirst).mockResolvedValue(
      scopedDoc(
        JSON.stringify({ docType: "business-requirements", pathPrefixes: ["packages/fit"] }),
      ),
    );
    await generateDocumentAsync("doc-1", "proj-1");
    expect(synthesizeHolisticDocument).toHaveBeenCalledWith(
      "proj-1",
      "business-requirements",
      "BR [scope: packages/fit/]",
      expect.objectContaining({ pathPrefixes: ["packages/fit"] }),
    );
    expect(mocked(buildProjectGroundingContext).mock.calls[0][0].pathPrefixes).toEqual([
      "packages/fit",
    ]);
    expect(mocked(buildSectionGroundingRetriever).mock.calls[0][0].pathPrefixes).toEqual([
      "packages/fit",
    ]);
  });

  it("an unscoped document passes no scope", async () => {
    mocked(prisma.generatedDocument.findFirst).mockResolvedValue(
      scopedDoc(JSON.stringify({ docType: "business-requirements" })),
    );
    await generateDocumentAsync("doc-1", "proj-1");
    expect(mocked(synthesizeHolisticDocument).mock.calls[0][3]).not.toHaveProperty("pathPrefixes");
    expect(mocked(buildProjectGroundingContext).mock.calls[0][0]).not.toHaveProperty(
      "pathPrefixes",
    );
  });

  it("a corrupted stored scope fails the run instead of documenting the whole project", async () => {
    mocked(prisma.generatedDocument.findFirst).mockResolvedValue(
      scopedDoc(JSON.stringify({ docType: "business-requirements", pathPrefixes: ["../etc"] })),
    );
    await generateDocumentAsync("doc-1", "proj-1");
    expect(synthesizeHolisticDocument).not.toHaveBeenCalled();
    expect(prisma.generatedDocument.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("an empty scope at run time fails with the specific, user-safe message", async () => {
    mocked(prisma.generatedDocument.findFirst).mockResolvedValue(
      scopedDoc(JSON.stringify({ docType: "business-requirements", pathPrefixes: ["tests"] })),
    );
    mocked(synthesizeHolisticDocument).mockRejectedValue(new PathScopeEmptyError(["tests"]));
    await generateDocumentAsync("doc-1", "proj-1");
    expect(prisma.generatedDocument.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorMessage: GENERATION_PATH_SCOPE_EMPTY_MESSAGE,
        }),
      }),
    );
  });
});
