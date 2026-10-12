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

// #1061 — the route reads the schema inventory for an architecture document.
vi.mock("../../src/lib/docs-gen/schema-inventory-loader.js", () => ({
  loadSchemaInventory: vi.fn(),
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
import { loadSchemaInventory } from "../../src/lib/docs-gen/schema-inventory-loader.js";
import { stopGeneration } from "../../src/lib/docs-gen/generation-control.js";
import type { SchemaInventory } from "../../src/lib/docs-gen/schema-inventory.js";
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
    mocked(prisma.codeSymbol.findMany).mockResolvedValue([
      { id: "sym-1", filePath: "packages/fit/a.ts" },
    ]);
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
    expect(prisma.codeSymbol.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        OR: [{ filePath: "packages/fit" }, { filePath: { startsWith: "packages/fit/" } }],
      },
      select: { id: true, filePath: true },
      orderBy: { id: "asc" },
      take: 500,
    });
  });

  it("pages the candidate scan by id", async () => {
    mocked(prisma.codeSymbol.findMany)
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, filePath: "other/x.ts" })),
      )
      .mockResolvedValueOnce([{ id: "t1", filePath: "packages/fit/a.ts" }]);
    const res = await post({ pathPrefixes: ["packages/fit"] });
    expect(res.status).toBe(202);
    expect(mocked(prisma.codeSymbol.findMany).mock.calls[1][0].where).toMatchObject({
      projectId: "proj-1",
      id: { gt: "s499" },
    });
  });

  // Prisma's `startsWith` is `LIKE (? || '%')` with `%`/`_` unescaped (and
  // case-insensitive on SQLite), so the DB can return rows the scope does not
  // contain. They must not satisfy the check: the run would then fail later
  // with PATH_SCOPE_EMPTY after the caller was told the scope was fine.
  it.each([["pack_ges/fit"], ["pack%/fit"], ["Packages/Fit"]])(
    "a LIKE false positive for %s is still a 400 PATH_SCOPE_EMPTY",
    async (prefix) => {
      mocked(prisma.codeSymbol.findMany)
        .mockResolvedValueOnce([{ id: "sym-1", filePath: "packages/fit/a.ts" }])
        .mockResolvedValue([]);
      const res = await post({ pathPrefixes: [prefix] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PATH_SCOPE_EMPTY");
      expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
    },
  );

  it("scopes the match check to the repository graph for repository scope", async () => {
    mocked(requireRepositoryGraph).mockResolvedValueOnce("graph-a");
    await post({
      scope: "repository",
      scopeFilter: { repoConnectorId: "repo-a" },
      pathPrefixes: ["packages/fit"],
    });
    expect(mocked(prisma.codeSymbol.findMany).mock.calls[0][0].where.codeGraphId).toBe("graph-a");
  });

  it("leaves an unscoped request unchanged", async () => {
    const res = await post({});
    expect(res.status).toBe(202);
    const data = mocked(prisma.generatedDocument.create).mock.calls[0][0].data;
    expect(data.title).toBe("BR");
    expect(JSON.parse(data.scopeFilter)).not.toHaveProperty("pathPrefixes");
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
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
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
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
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });

  it("an inconclusive scan (page cap reached) is accepted, not reported empty", async () => {
    mocked(prisma.codeSymbol.findMany).mockImplementation(async () =>
      Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, filePath: "packagesXfit/x.ts" })),
    );
    const res = await post({ pathPrefixes: ["packages_fit"] });
    expect(res.status).toBe(202);
    expect(prisma.codeSymbol.findMany).toHaveBeenCalledTimes(20);
  });

  it("returns a clear 400 when the prefixes match no indexed code", async () => {
    mocked(prisma.codeSymbol.findMany).mockResolvedValue([]);
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

  // #1061 (panel) — nothing tested that the schema inventory reaches synthesis:
  // disabling the load in the route left every test green.
  describe("the schema inventory of an architecture document (#1061)", () => {
    const INVENTORY: SchemaInventory = {
      source: "live-schema",
      label: 'the live schema of "pg" (public)',
      reads: [{ connector: "pg", how: "live", schemas: ["public"] }],
      tables: [{ schema: "public", name: "users", read: 0, columns: [], foreignKeys: [] }],
    };
    const architecture = (extra: Record<string, unknown> = {}) =>
      mocked(prisma.generatedDocument.findFirst).mockResolvedValue(
        scopedDoc(JSON.stringify({ docType: "architecture", ...extra })),
      );

    beforeEach(() => {
      mocked(loadSchemaInventory).mockReset();
      mocked(loadSchemaInventory).mockResolvedValue(INVENTORY);
    });

    it("is read as the acting user and handed to synthesis", async () => {
      architecture();
      await generateDocumentAsync("doc-1", "proj-1");
      expect(loadSchemaInventory).toHaveBeenCalledTimes(1);
      expect(mocked(loadSchemaInventory).mock.calls[0][0]).toMatchObject({
        projectId: "proj-1",
        actorId: "user_admin",
      });
      expect(mocked(synthesizeHolisticDocument).mock.calls[0][1]).toBe("architecture");
      expect(mocked(synthesizeHolisticDocument).mock.calls[0][3].schemaInventory).toBe(INVENTORY);
    });

    it("is read with the generation's own signal, so a cancel ends the read", async () => {
      architecture();
      await generateDocumentAsync("doc-1", "proj-1");
      const { signal } = mocked(loadSchemaInventory).mock.calls[0][0] as { signal: AbortSignal };
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("a generation cancelled during the read does not go on to synthesis", async () => {
      architecture();
      mocked(loadSchemaInventory).mockImplementation(
        async ({ signal }: { signal: AbortSignal }) => {
          // The cancel route does this for a run in this process.
          stopGeneration("doc-1", "aborted");
          expect(signal.aborted).toBe(true);
          return INVENTORY;
        },
      );
      await generateDocumentAsync("doc-1", "proj-1");
      expect(loadSchemaInventory).toHaveBeenCalledTimes(1);
      expect(synthesizeHolisticDocument).not.toHaveBeenCalled();
    });

    it("is not read for any other document type", async () => {
      for (const docType of ["business-requirements", "user-guide"]) {
        mocked(prisma.generatedDocument.findFirst).mockResolvedValue(
          scopedDoc(JSON.stringify({ docType })),
        );
        await generateDocumentAsync("doc-1", "proj-1");
      }
      expect(loadSchemaInventory).not.toHaveBeenCalled();
      for (const call of mocked(synthesizeHolisticDocument).mock.calls) {
        expect(call[3]).not.toHaveProperty("schemaInventory");
      }
    });

    // #1061 second review — names the schema check could not match are
    // information. The document is published `ready`, with the note stored
    // for the page to show; it used to be published `degraded`.
    it("publishes a document whose only warning is the schema note as ready", async () => {
      const real = await vi.importActual<
        typeof import("../../src/lib/docs-gen/grounding/degraded-warnings.js")
      >("../../src/lib/docs-gen/grounding/degraded-warnings.js");
      const derive = mocked(
        (await import("../../src/lib/docs-gen/grounding/degraded-warnings.js")).deriveDocStatus,
      );
      const stub = derive.getMockImplementation();
      derive.mockImplementation(real.deriveDocStatus);
      try {
        const note = real.schemaUnverifiedWarning("Data Architecture", ["jobs"], INVENTORY);
        mocked(synthesizeHolisticDocument).mockResolvedValue({
          markdown: "# Synthesized",
          warnings: [note],
          provenanceManifest: null,
        });
        architecture();
        await generateDocumentAsync("doc-1", "proj-1");
        const published = mocked(prisma.generatedDocument.update)
          .mock.calls.map(([args]) => (args as { data: Record<string, unknown> }).data)
          .find((data) => data.content === "# Synthesized");
        expect(published).toMatchObject({ status: "ready", warnings: [note] });

        // Beside a real degradation the document is degraded, and keeps both.
        const failed = real.sectionFailedWarning("Overview", "x");
        mocked(synthesizeHolisticDocument).mockResolvedValue({
          markdown: "# Again",
          warnings: [note, failed],
          provenanceManifest: null,
        });
        architecture();
        await generateDocumentAsync("doc-1", "proj-1");
        const again = mocked(prisma.generatedDocument.update)
          .mock.calls.map(([args]) => (args as { data: Record<string, unknown> }).data)
          .find((data) => data.content === "# Again");
        expect(again).toMatchObject({ status: "degraded", warnings: [note, failed] });
      } finally {
        derive.mockImplementation(stub!);
      }
    });

    // Stated plainly, because it is a data-flow decision: a connector belongs
    // to the project and records no repository or path, so a path-scoped
    // architecture document still reads every database of the project. Only
    // the repository-SQL tier is narrowed, by the document's code graph.
    it("a path-scoped document reads the project's databases all the same", async () => {
      mocked(resolveEvidencePolicy).mockResolvedValue({
        projectId: "proj-1",
        generatedDocumentId: "doc-1",
        actor: { userId: "user_admin", role: "admin" },
        sharedDocumentIds: [],
        allowWebResearch: false,
        codeGraphId: "graph-a",
        repoConnectorId: "repo-a",
      });
      architecture({ pathPrefixes: ["packages/fit"] });
      await generateDocumentAsync("doc-1", "proj-1");
      const input = mocked(loadSchemaInventory).mock.calls[0][0];
      expect(input).toMatchObject({ projectId: "proj-1", codeGraphId: "graph-a" });
      expect(input).not.toHaveProperty("pathPrefixes");
      expect(input).not.toHaveProperty("repoConnectorId");
    });
  });
});
