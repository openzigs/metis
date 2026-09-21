/**
 * Integration tests for the analysis HTTP surface.
 *
 * Mocks Prisma in-memory and injects a stub orchestrator so the route
 * handlers can be exercised end-to-end without booting the real pipeline.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  createdById: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface AnalysisRow {
  id: string;
  projectId: string;
  startedById: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorMessage: string | null;
  metadata: string | null;
  deletedAt: Date | null;
  agentResults?: Array<Record<string, unknown>>;
  requirements?: Array<Record<string, unknown>>;
}

const projects = new Map<string, ProjectRow>();
const analyses = new Map<string, AnalysisRow>();
const requirements = new Map<
  string,
  {
    id: string;
    analysisId: string;
    projectId: string;
    deletedAt: Date | null;
    labels: string;
    reviewStatus: string | null;
  }
>();
// Epic #201 (#210) — in-memory stand-in for the clarification_dialog_states table.
const dialogStateStore = new Map<string, string>();
let id = 0;
const nid = (p: string) => `${p}_${++id}`;

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: `user_${create.username}`,
          ...create,
        }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        const p = projects.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
      // #674 — requireProjectAccess chokepoint. Null workspaceId → open to any
      // authed caller, preserving this suite's focus on analysis + IDOR behaviour.
      findUnique: vi.fn(async () => ({ workspaceId: null })),
    },
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; projectId?: string } }) => {
        if (!where.id) return null;
        const a = analyses.get(where.id);
        if (!a || a.deletedAt) return null;
        // IDOR defence: when scoped by projectId, enforce ownership (mirrors the
        // Prisma query's compound where → null on mismatch).
        if (where.projectId && a.projectId !== where.projectId) return null;
        const reqs = [...requirements.values()].filter(
          (r) => r.analysisId === a.id && !r.deletedAt,
        );
        return { ...a, agentResults: a.agentResults ?? [], requirements: reqs };
      }),
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) =>
        [...analyses.values()].filter((a) => a.projectId === where.projectId && !a.deletedAt),
      ),
      // Epic #201 (#211) — clarify route now persists refined requirements via
      // persistAnalysisEnhancement → analysis.update(metadata).
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { metadata?: string } }) => {
          const a = analyses.get(where.id);
          if (!a) throw new Error("not found");
          if (data.metadata !== undefined) a.metadata = data.metadata;
          return a;
        },
      ),
    },
    // Epic #201 (#210) — durable clarification dialog state table.
    clarificationDialogState: {
      findUnique: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        const s = dialogStateStore.get(where.analysisId);
        return s ? { state: s } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { analysisId: string };
          create: { analysisId: string; state: string };
          update: { state: string };
        }) => {
          dialogStateStore.set(
            where.analysisId,
            dialogStateStore.has(where.analysisId) ? update.state : create.state,
          );
          return { analysisId: where.analysisId, state: dialogStateStore.get(where.analysisId) };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        const existed = dialogStateStore.delete(where.analysisId);
        return { count: existed ? 1 : 0 };
      }),
    },
    requirement: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; analysisId?: string; deletedAt: null } }) => {
          const r = requirements.get(where.id);
          if (!r || r.deletedAt) return null;
          if (where.analysisId !== undefined && r.analysisId !== where.analysisId) return null;
          return r;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { labels?: string; reviewStatus?: string | null };
        }) => {
          const r = requirements.get(where.id);
          if (!r) throw new Error("not found");
          if (data.labels !== undefined) r.labels = data.labels;
          if (data.reviewStatus !== undefined) r.reviewStatus = data.reviewStatus ?? null;
          return r;
        },
      ),
    },
    // Epic #203 (#221) — cross-doc findings read by getAnalysisSnapshot.
    crossDocFinding: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: { analysisId: string } }) => ({
        id: "cdf_1",
        ...data,
        createdAt: new Date(),
      })),
    },
    // Issue #733 — capability preview probe reads code graph + repo-source docs.
    codeGraph: { findFirst: vi.fn(async () => null) },
    document: { findFirst: vi.fn(async () => null) },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(),
}));

// ── Hard LLM/retrieval guard (spec + CLAUDE.md: no real provider/network calls) ──
// The /clarify + /clarify/import route handlers construct a live
// ClarificationDialog via `buildProvider({ config })` + `getKnowledgeService()`.
// Without these mocks, `resolveAmbiguities` reaches `provider.chat(...)` (it is
// driven by the round's questions, not by the ambiguity count, so the
// zero-ambiguity seed does NOT prevent the call) and only the route's
// log-and-continue try/catch hides a would-be real LLM call when AI env is set
// in CI. We replace provider construction with a deterministic offline stub and
// stub the retriever so the submit path is guaranteed network-free and the
// resolution step is a deterministic no-op. `chat` is also a spy so a future
// regression that *expects* a real model surfaces here instead of silently
// no-opping.
const providerChat = vi.fn(async () => ({
  // Empty resolution → parseResolution yields no resolved fields / description,
  // so submitAnswers returns the requirements unchanged, deterministically.
  content: "{}",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  model: "offline-stub",
  provider: "offline-stub",
  offline: true,
}));

vi.mock("../src/lib/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/index.js")>();
  return {
    ...actual,
    // Deterministic, offline provider — never touches the network.
    buildProvider: vi.fn(() => ({ offline: true, chat: providerChat })),
    // Avoid loading real AI env/config in tests.
    loadAIConfig: vi.fn(() => ({ provider: "offline-stub", model: "offline-stub" })),
  };
});

vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>();
  return {
    ...actual,
    // The retriever is only consulted on the START branch's grounding pass
    // (skipped here because the stub provider is `offline`); stub it so it can
    // never reach LanceDB / embeddings.
    getKnowledgeService: vi.fn(() => ({ search: vi.fn(async () => []) })),
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  AnalysisOrchestrator,
  AnalysisNotRegeneratableError,
  CostCapExceededError,
  setOrchestratorForTests,
} from "../src/lib/analysis/index.js";

let app: ReturnType<typeof createApp>;
let adminToken: string;
let readerToken: string;

async function loginAs(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

class StubOrchestrator extends AnalysisOrchestrator {
  startCalls: Array<Record<string, unknown>> = [];
  cancelCalls: string[] = [];
  regenCalls: Array<Record<string, unknown>> = [];
  assertRegenCalls: string[] = [];
  shouldThrowCap = false;
  /** When set, `start()` throws the matching error to exercise the route catch arms. */
  startBehavior: "ok" | "not-found" | "archived" = "ok";
  /** When set, `assertCanRegenerate` throws the supplied error instead of resolving. */
  regenPreflightError: Error | null = null;

  constructor() {
    super({
      provider: {} as never,
      retrieve: async () => [],
    });
  }

  override async start(opts: {
    projectId: string;
    startedById: string;
    agentKeys?: readonly string[];
    documentIds?: readonly string[];
    model?: string;
    extraInstructions?: string;
  }): Promise<{ id: string }> {
    this.startCalls.push(opts);
    if (this.shouldThrowCap) {
      throw new CostCapExceededError(100, 200);
    }
    if (this.startBehavior === "not-found") {
      throw new Error("Project not found");
    }
    if (this.startBehavior === "archived") {
      throw new Error("Project archived");
    }
    const aId = nid("ana");
    analyses.set(aId, {
      id: aId,
      projectId: opts.projectId,
      startedById: opts.startedById,
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      errorMessage: null,
      metadata: JSON.stringify({
        agentKeys: opts.agentKeys ?? [],
        documentIds: opts.documentIds ?? [],
      }),
      deletedAt: null,
    });
    return { id: aId };
  }

  override async cancel(analysisId: string, _actorId: string): Promise<boolean> {
    this.cancelCalls.push(analysisId);
    return true;
  }

  override async assertCanRegenerate(analysisId: string): Promise<{ analysis: never }> {
    this.assertRegenCalls.push(analysisId);
    if (this.regenPreflightError) throw this.regenPreflightError;
    return { analysis: undefined as never };
  }

  override async regenerateAgent(opts: {
    analysisId: string;
    agentKey: string;
    actorId: string;
  }): Promise<void> {
    this.regenCalls.push(opts);
  }
}

let orch: StubOrchestrator;

beforeAll(() => {
  // setup.ts pins JWT/vault env already.
});

beforeEach(async () => {
  projects.clear();
  analyses.clear();
  requirements.clear();
  dialogStateStore.clear();
  id = 0;
  projects.set("proj-abcdefghij", {
    id: "proj-abcdefghij",
    name: "Acme",
    slug: "acme",
    description: "monolith",
    status: "active",
    createdById: "user_admin",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  app = createApp();
  orch = new StubOrchestrator();
  setOrchestratorForTests(orch);

  adminToken = await loginAs("admin", "password");
  readerToken = await loginAs("reader", "password");
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/projects/:projectId/analyses", () => {
  it("starts an analysis as admin (202)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentKeys: ["document", "code"] });
    expect(res.status).toBe(202);
    expect(res.body.data.id).toMatch(/^ana_/);
    expect(orch.startCalls).toHaveLength(1);
    expect(orch.startCalls[0].agentKeys).toEqual(["document", "code"]);
  });

  it("forwards extraInstructions to the orchestrator (#905)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentKeys: ["code"], extraInstructions: "Add audit logging to all mutations" });
    expect(res.status).toBe(202);
    expect(orch.startCalls).toHaveLength(1);
    expect(orch.startCalls[0].extraInstructions).toBe("Add audit logging to all mutations");
  });

  it("omits extraInstructions when not provided (#905)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentKeys: ["code"] });
    expect(res.status).toBe(202);
    expect(orch.startCalls[0].extraInstructions).toBeUndefined();
  });

  it("forwards the enhancement opt-in flags to the orchestrator (Epic #922)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentKeys: ["code"], enableWebResearch: true, enableClarification: true });
    expect(res.status).toBe(202);
    expect(orch.startCalls[0].enableWebResearch).toBe(true);
    expect(orch.startCalls[0].enableClarification).toBe(true);
  });

  it("defaults the enhancement flags to false when omitted (Epic #922)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentKeys: ["code"] });
    expect(res.status).toBe(202);
    expect(orch.startCalls[0].enableWebResearch).toBe(false);
    expect(orch.startCalls[0].enableClarification).toBe(false);
  });

  it("rejects extraInstructions over 4096 chars (400) (#905)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ extraInstructions: "a".repeat(4097) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects readers without analysis.run (403)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${readerToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("requires authentication (401)", async () => {
    const res = await request(app).post("/api/projects/proj-abcdefghij/analyses").send({});
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown projects", async () => {
    const res = await request(app)
      .post("/api/projects/missing-id-12345/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 429 when the monthly cap is exceeded", async () => {
    orch.shouldThrowCap = true;
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("ANALYSIS_MONTHLY_CAP_EXCEEDED");
  });

  it("rejects invalid agent keys (400)", async () => {
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentKeys: ["nonsense"] });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/:projectId/analyses", () => {
  it("lists analyses for the project as reader", async () => {
    await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
      agentKeys: ["document"],
    });
    const res = await request(app)
      .get("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });
});

describe("GET /api/projects/:projectId/analyses/capability (#733)", () => {
  it("returns the static capability probe for a bare project (graph/source absent, flags ON by default #752)", async () => {
    const res = await request(app)
      .get("/api/projects/proj-abcdefghij/analyses/capability")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      codeGraphPresent: false,
      repoSourceIngested: false,
      // #752 — both grounding flags default ON; the bare project is degraded
      // only because no code graph / repo source exists yet.
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    });
  });

  it("reflects a present code graph in the probe", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    vi.mocked(prisma.codeGraph.findFirst).mockResolvedValueOnce({ id: "cg-1" } as never);
    const res = await request(app)
      .get("/api/projects/proj-abcdefghij/analyses/capability")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.codeGraphPresent).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/projects/proj-abcdefghij/analyses/capability");
    expect(res.status).toBe(401);
  });
});

describe("/api/analyses top-level routes", () => {
  it("GET /personas returns the registry", async () => {
    const res = await request(app)
      .get("/api/analyses/personas")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const keys = res.body.data.items.map((p: { agentKey: string }) => p.agentKey);
    expect(keys.sort()).toEqual(["code", "database", "document", "synthesis", "web"]);
  });

  it("GET /cost-cap returns usage info for readers", async () => {
    const res = await request(app)
      .get("/api/analyses/cost-cap")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("monthlyCap");
  });

  it("GET /:id returns the snapshot", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    const res = await request(app)
      .get(`/api/analyses/${aId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(aId);
  });

  it("GET /:id returns 404 when missing", async () => {
    const res = await request(app)
      .get(`/api/analyses/missing-id-12345`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("POST /:id/cancel calls the orchestrator", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    const res = await request(app)
      .post(`/api/analyses/${aId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(orch.cancelCalls).toContain(aId);
  });

  it("POST /:id/agents/:agentKey/regenerate (202) and rejects bad keys (400)", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    const ok = await request(app)
      .post(`/api/analyses/${aId}/agents/document/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.status).toBe(202);

    const bad = await request(app)
      .post(`/api/analyses/${aId}/agents/synthesis/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
  });

  it("PATCH /:id/requirements/:reqId updates labels + review status", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    requirements.set("req_1", {
      id: "req_1",
      analysisId: aId,
      projectId: "proj-abcdefghij",
      deletedAt: null,
      labels: JSON.stringify(["initial", "review:draft"]),
      reviewStatus: null,
    });
    const res = await request(app)
      .patch(`/api/analyses/${aId}/requirements/req_1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reviewStatus: "approved" });
    expect(res.status).toBe(200);
    // M4: review status now lives on a typed column; the legacy `review:*`
    // label should be stripped on write so we don't double-source the value.
    expect(requirements.get("req_1")!.reviewStatus).toBe("approved");
    const labels = JSON.parse(requirements.get("req_1")!.labels) as string[];
    expect(labels.some((l) => l.startsWith("review:"))).toBe(false);
  });

  it("PATCH returns 404 for missing requirements", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    const res = await request(app)
      .patch(`/api/analyses/${aId}/requirements/missing-id-12345`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reviewStatus: "approved" });
    expect(res.status).toBe(404);
  });

  it("PATCH returns 404 when the requirement belongs to a different analysis (IDOR)", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    const { id: otherId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    requirements.set("req_x", {
      id: "req_x",
      analysisId: otherId,
      projectId: "proj-abcdefghij",
      deletedAt: null,
      labels: "[]",
      reviewStatus: null,
    });
    const res = await request(app)
      .patch(`/api/analyses/${aId}/requirements/req_x`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reviewStatus: "approved" });
    expect(res.status).toBe(404);
    expect(requirements.get("req_x")!.reviewStatus).toBeNull();
  });

  it("POST regenerate returns 429 when the cost cap is exceeded", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    orch.regenPreflightError = new CostCapExceededError(100, 200);
    const res = await request(app)
      .post(`/api/analyses/${aId}/agents/document/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("ANALYSIS_MONTHLY_CAP_EXCEEDED");
    // The fire-and-forget pipeline must NOT have been kicked off.
    expect(orch.regenCalls).toHaveLength(0);
  });

  it("POST regenerate returns 409 when the analysis is still running", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    orch.regenPreflightError = new AnalysisNotRegeneratableError(aId, "running");
    const res = await request(app)
      .post(`/api/analyses/${aId}/agents/document/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_REGENERATABLE");
    expect(orch.regenCalls).toHaveLength(0);
  });

  it("POST regenerate returns 404 when assertCanRegenerate reports `not found`", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    orch.regenPreflightError = new Error("Analysis not found");
    const res = await request(app)
      .post(`/api/analyses/${aId}/agents/document/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    expect(orch.regenCalls).toHaveLength(0);
  });

  it("POST regenerate returns 409 when assertCanRegenerate reports `archived`", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    orch.regenPreflightError = new Error("Project archived");
    const res = await request(app)
      .post(`/api/analyses/${aId}/agents/document/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROJECT_ARCHIVED");
    expect(orch.regenCalls).toHaveLength(0);
  });

  it("POST regenerate propagates an unknown preflight error as 500", async () => {
    const { id: aId } = await orch.start({
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
    });
    orch.regenPreflightError = new Error("kaboom");
    const res = await request(app)
      .post(`/api/analyses/${aId}/agents/document/regenerate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(500);
    expect(orch.regenCalls).toHaveLength(0);
  });

  it("POST start returns 404 when the orchestrator reports the project missing", async () => {
    orch.startBehavior = "not-found";
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("POST start returns 409 when the orchestrator reports the project archived", async () => {
    orch.startBehavior = "archived";
    const res = await request(app)
      .post("/api/projects/proj-abcdefghij/analyses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROJECT_ARCHIVED");
  });
});

describe("POST /api/projects/:projectId/analyses/:id/clarify (Epic #922)", () => {
  const seedAnalysis = (metadata: Record<string, unknown>): string => {
    const aId = nid("ana");
    analyses.set(aId, {
      id: aId,
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      errorMessage: null,
      metadata: JSON.stringify(metadata),
      deletedAt: null,
    });
    return aId;
  };

  it("returns 400 when neither the body nor persisted metadata supply requirements", async () => {
    const aId = seedAnalysis({ agentKeys: ["document"] });
    const res = await request(app)
      .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("falls back to server-sourced structured requirements when the body omits them", async () => {
    // No ambiguities ⇒ the dialog completes immediately without an LLM call,
    // so this deterministically exercises the server-sourced fallback path.
    const aId = seedAnalysis({
      agentKeys: ["document"],
      structuredRequirements: {
        requirements: [
          {
            id: "req-1",
            title: "Audit logging",
            description: "Retain logs",
            type: "non-functional",
            stakeholders: [],
            priority: "must-have",
            ambiguities: [],
            evidenceNeeds: [],
            rawSource: "raw",
          },
        ],
        totalAmbiguities: 0,
        totalEvidenceNeeds: 0,
      },
    });
    const res = await request(app)
      .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(true);
  });

  // Epic #201 (#213) — GET returns the durable dialog state so the UI can
  // rehydrate an in-flight dialog after reload/restart.
  it("GET returns null state when no dialog has been started", async () => {
    const aId = seedAnalysis({ agentKeys: ["document"] });
    const res = await request(app)
      .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBeNull();
  });

  it("GET rehydrates a started dialog from durable state", async () => {
    const structuredRequirements = {
      requirements: [
        {
          id: "req-1",
          title: "Audit logging",
          description: "Retain logs",
          type: "non-functional",
          stakeholders: [],
          priority: "must-have",
          ambiguities: [],
          evidenceNeeds: [],
          rawSource: "raw",
        },
      ],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 0,
    };
    const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements });
    // Start a dialog (persists durable state).
    await request(app)
      .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ requirements: structuredRequirements });

    const res = await request(app)
      .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.state).not.toBeNull();
    expect(res.body.data.state.analysisId).toBe(aId);
  });

  // Epic #201 (#211) — submitting answers must persist the refined requirements
  // back into Analysis.metadata so the loop closes and synthesis can read them.
  it("persists refined requirements to metadata when answers are submitted", async () => {
    const structuredRequirements = {
      requirements: [
        {
          id: "req-1",
          title: "Audit logging",
          description: "Retain logs",
          type: "non-functional",
          stakeholders: [],
          priority: "must-have",
          ambiguities: [{ field: "retention", description: "how long?", suggestedQuestion: "?" }],
          evidenceNeeds: [],
          rawSource: "raw",
        },
      ],
      totalAmbiguities: 1,
      totalEvidenceNeeds: 0,
    };
    const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements });

    // Start a round so there is an active dialog to answer.
    const start = await request(app)
      .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ requirements: structuredRequirements });
    expect(start.status).toBe(200);

    // Submit answers — even if the offline stub resolves nothing, the route
    // must still persist the (refined) requirements idempotently.
    const submit = await request(app)
      .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        requirements: structuredRequirements,
        answers: [{ questionId: "q-unknown", answer: "30 days" }],
      });
    expect(submit.status).toBe(200);

    // The refined requirements are now retrievable from the persisted metadata.
    const meta = JSON.parse(analyses.get(aId)!.metadata as string) as {
      structuredRequirements?: { requirements: Array<{ id: string }> };
    };
    expect(meta.structuredRequirements).toBeDefined();
    expect(meta.structuredRequirements!.requirements[0]!.id).toBe("req-1");
  });
});

// ── Clarifying-question CSV export / import (Business Analyst round-trip) ──
describe("Clarify CSV export/import", () => {
  const seedAnalysis = (metadata: Record<string, unknown>): string => {
    const aId = nid("ana");
    analyses.set(aId, {
      id: aId,
      projectId: "proj-abcdefghij",
      startedById: "user_admin",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      errorMessage: null,
      metadata: JSON.stringify(metadata),
      deletedAt: null,
    });
    return aId;
  };

  /** Seed a durable dialog round with the supplied questions (no LLM needed). */
  const seedDialog = (analysisId: string, questions: Array<Record<string, unknown>>): void => {
    dialogStateStore.set(
      analysisId,
      JSON.stringify({
        analysisId,
        currentRound: 1,
        maxRounds: 3,
        rounds: [{ round: 1, questions, answers: [] }],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      }),
    );
  };

  const structuredReqs = {
    requirements: [
      {
        id: "req-1",
        title: "Audit logging",
        description: "Retain logs",
        type: "non-functional",
        stakeholders: [],
        priority: "must-have",
        ambiguities: [],
        evidenceNeeds: [],
        rawSource: "raw",
      },
    ],
    totalAmbiguities: 0,
    totalEvidenceNeeds: 0,
  };

  const questions = [
    {
      id: "q-1",
      requirementId: "req-1",
      ambiguityField: "retention",
      question: "How long should logs be retained?",
      context: "",
      groundingStatus: "grounded",
      groundedAnswer: "7 years",
    },
    {
      id: "q-2",
      requirementId: "req-1",
      ambiguityField: "format",
      question: "What log format?",
      context: "",
    },
  ];

  // ── Export ──────────────────────────────────────────────────────────────
  describe("GET .../clarify/export", () => {
    it("returns 409 when no dialog has been started", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      const res = await request(app)
        .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/export?format=csv`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_DIALOG_QUESTIONS");
    });

    it("returns 409 when the latest round has no questions", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, []);
      const res = await request(app)
        .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/export?format=csv`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_DIALOG_QUESTIONS");
    });

    it("returns a text/csv attachment with the exact header + mapped rows", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const res = await request(app)
        .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/export?format=csv`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain(
        `filename="clarifying-questions-${aId}.csv"`,
      );
      const lines = res.text.split("\r\n");
      expect(lines[0]).toBe(
        "questionId,requirement,ambiguityField,question,suggestedAnswer,answer",
      );
      // requirement column resolves to the structuredRequirements title.
      expect(lines[1]).toContain("Audit logging");
      // suggestedAnswer carries the grounded answer; answer is blank.
      expect(lines[1]!.startsWith("q-1,Audit logging,retention,")).toBe(true);
      expect(lines[1]!.endsWith(",7 years,")).toBe(true);
      // open question: no suggested answer, blank answer.
      expect(lines[2]!.startsWith("q-2,Audit logging,format,")).toBe(true);
      expect(lines[2]!.endsWith(",,")).toBe(true);
    });

    it("returns JSON rows for format=json", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const res = await request(app)
        .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/export?format=json`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.rows).toHaveLength(2);
      expect(res.body.data.rows[0]).toMatchObject({
        questionId: "q-1",
        requirement: "Audit logging",
        suggestedAnswer: "7 years",
        answer: "",
      });
    });

    it("falls back to requirementId when the title is missing", async () => {
      const aId = seedAnalysis({
        agentKeys: ["document"],
        structuredRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
      });
      seedDialog(aId, [questions[0]!]);
      const res = await request(app)
        .get(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/export?format=json`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.rows[0].requirement).toBe("req-1");
    });

    it("404s on IDOR (wrong projectId)", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const res = await request(app)
        .get(`/api/projects/proj-wrongwrong/analyses/${aId}/clarify/export?format=csv`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ── Import ──────────────────────────────────────────────────────────────
  describe("POST .../clarify/import", () => {
    const csvFor = (rows: string) =>
      `questionId,requirement,ambiguityField,question,suggestedAnswer,answer\r\n${rows}`;

    it("applies matched answers via submitAnswers + persists enhancement", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const csv = csvFor(
        "q-1,Audit logging,retention,Q,,7 years\r\nq-2,Audit logging,format,Q,,JSON lines\r\n",
      );
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ applied: 2, skipped: 0, unmatched: [] });
      // Refined requirements were persisted back to metadata (loop closed).
      const meta = JSON.parse(analyses.get(aId)!.metadata as string) as {
        structuredRequirements?: unknown;
      };
      expect(meta.structuredRequirements).toBeDefined();
      // The matched answers flowed through the EXISTING submit path: resolveAmbiguities
      // ran against the round's question (req-1) using the deterministic offline
      // stub, so exactly one provider.chat happened — proving the path is exercised
      // for real (not silently no-op'd by the route's try/catch) yet LLM-free.
      expect(providerChat).toHaveBeenCalledTimes(1);
    });

    it("skips blank-answer rows and reports unmatched questionIds", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const csv = csvFor(
        "q-1,Audit logging,retention,Q,,7 years\r\nq-2,Audit logging,format,Q,,\r\nq-bogus,X,Y,Q,,some answer\r\n",
      );
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ applied: 1, skipped: 1, unmatched: ["q-bogus"] });
    });

    it("returns { applied: 0 } without calling submit when nothing matches with an answer", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const csv = csvFor("q-1,Audit logging,retention,Q,,\r\nq-2,Audit logging,format,Q,,\r\n");
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ applied: 0, skipped: 2, unmatched: [] });
    });

    it("400s on malformed CSV (missing required columns)", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from("foo,bar\r\n1,2\r\n"), "answers.csv");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("400s when no dialog exists", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      const csv = csvFor("q-1,Audit logging,retention,Q,,7 years\r\n");
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NO_DIALOG");
    });

    it("400s when requirements metadata is missing", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"] });
      seedDialog(aId, questions);
      const csv = csvFor("q-1,Audit logging,retention,Q,,7 years\r\n");
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("400s when the file field is missing", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
    });

    it("400s on a non-.csv file", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const csv = csvFor("q-1,Audit logging,retention,Q,,7 years\r\n");
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), { filename: "answers.txt", contentType: "text/plain" });
      expect(res.status).toBe(400);
    });

    it("404s on IDOR (wrong projectId)", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      const csv = csvFor("q-1,Audit logging,retention,Q,,7 years\r\n");
      const res = await request(app)
        .post(`/api/projects/proj-wrongwrong/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(404);
    });

    it("400s (FILE_TOO_LARGE) when the upload exceeds the size cap", async () => {
      const aId = seedAnalysis({ agentKeys: ["document"], structuredRequirements: structuredReqs });
      seedDialog(aId, questions);
      // 10MB + 1 byte exceeds MAX_DOCUMENT_BYTES → multer LIMIT_FILE_SIZE → 400.
      const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
      const res = await request(app)
        .post(`/api/projects/proj-abcdefghij/analyses/${aId}/clarify/import`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", tooBig, "answers.csv");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    });
  });
});
