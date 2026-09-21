/**
 * Integration tests for the finding deep-dive HTTP endpoint (Issue #178).
 *
 *   POST /api/projects/:projectId/analyses/:id/findings/:findingId/deep-dive
 *
 * Prisma is mocked in-memory and a stub orchestrator (carrying a fake AI
 * provider) is injected so the route is exercised end-to-end without booting
 * the real pipeline or hitting a model. Cost-cap enforcement is partially
 * mocked so the 429 arm can be driven deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";

interface FindingRow {
  id: string;
  analysisId: string;
  projectId: string;
  agentKey: string;
  title: string;
  body: string;
  category: string;
  severity: string;
  evidence: string | null;
  projectName: string;
}

const projects = new Map<string, { id: string; name: string; deletedAt: Date | null }>();
const analyses = new Map<string, { id: string; projectId: string; deletedAt: Date | null }>();
const findings = new Map<string, FindingRow>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: `user_${create.username}`,
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    analysis: {
      // Cost-cap usage query — return an empty set so the cap is never hit
      // unless the cost-cap module mock is told to throw.
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        const a = analyses.get(where.id);
        return a && !a.deletedAt ? a : null;
      }),
    },
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        const p = projects.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
      // #674 — requireProjectAccess chokepoint. Null workspaceId → open to any
      // authed caller, preserving this suite's focus on deep-dive + IDOR.
      findUnique: vi.fn(async () => ({ workspaceId: null })),
    },
    finding: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            agentResult?: { analysis?: { id?: string; project?: { id?: string } } };
          };
        }) => {
          const f = findings.get(where.id);
          if (!f) return null;
          const wantAnalysis = where.agentResult?.analysis?.id;
          const wantProject = where.agentResult?.analysis?.project?.id;
          if (wantAnalysis !== undefined && f.analysisId !== wantAnalysis) return null;
          if (wantProject !== undefined && f.projectId !== wantProject) return null;
          return {
            id: f.id,
            title: f.title,
            body: f.body,
            category: f.category,
            severity: f.severity,
            evidence: f.evidence,
            agentResult: {
              agentKey: f.agentKey,
              analysis: { project: { name: f.projectName } },
            },
          };
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(),
}));

// Partially mock cost-cap so we can force the 429 arm without touching config.
let costCapShouldThrow = false;
vi.mock("../src/lib/analysis/cost-cap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/analysis/cost-cap.js")>();
  return {
    ...actual,
    assertCanStartAnalysis: vi.fn(async () => {
      if (costCapShouldThrow) throw new actual.CostCapExceededError(100, 200);
    }),
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { AnalysisOrchestrator, setOrchestratorForTests } from "../src/lib/analysis/index.js";

let app: ReturnType<typeof createApp>;
let adminToken: string;
let readerToken: string;

async function loginAs(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

const VALID_DRAFT = {
  title: "Add audit logging to all mutations",
  problemStatement: "Mutations are not audited, which fails the compliance requirement.",
  affected: { files: ["src/routes/users.ts"], requirementIds: ["REQ-12"] },
  acceptanceCriteria: ["Every mutation writes an AuditLog row"],
  suggestedLabels: ["security"],
};

class StubOrchestrator extends AnalysisOrchestrator {
  chatMock = vi.fn(
    async (_messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> => ({
      content: JSON.stringify(VALID_DRAFT),
      usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 },
      model: opts?.model ?? "haiku",
      provider: "offline-stub",
    }),
  );

  constructor() {
    super({
      provider: {
        key: "offline-stub",
        model: "stub",
        offline: false,
        chat: (m: ChatMessage[], o?: ChatOptions) => this.chatMock(m, o),
        stream: vi.fn(),
        embed: vi.fn(),
        models: vi.fn(),
      } as never,
      retrieve: async () => [],
    } as never);
  }
}

let orch: StubOrchestrator;

const PROJECT_ID = "proj-abcdefghij";
const ANALYSIS_ID = "ana_1";
const FINDING_ID = "find_1";

function seedFinding(): void {
  findings.set(FINDING_ID, {
    id: FINDING_ID,
    analysisId: ANALYSIS_ID,
    projectId: PROJECT_ID,
    agentKey: "code",
    title: "No audit logging",
    body: "User mutations are not recorded.",
    category: "security",
    severity: "high",
    evidence: JSON.stringify({
      citations: [{ documentId: "doc1", chunkIndex: 2, filename: "users.ts", snippet: "x" }],
      tags: ["audit"],
      requirementId: "REQ-12",
    }),
    projectName: "Acme",
  });
}

beforeEach(async () => {
  projects.clear();
  analyses.clear();
  findings.clear();
  costCapShouldThrow = false;

  projects.set(PROJECT_ID, { id: PROJECT_ID, name: "Acme", deletedAt: null });
  analyses.set(ANALYSIS_ID, { id: ANALYSIS_ID, projectId: PROJECT_ID, deletedAt: null });
  seedFinding();

  app = createApp();
  orch = new StubOrchestrator();
  setOrchestratorForTests(orch);

  adminToken = await loginAs("admin", "password");
  readerToken = await loginAs("reader", "password");
});

afterEach(() => vi.clearAllMocks());

const url = `/api/projects/${PROJECT_ID}/analyses/${ANALYSIS_ID}/findings/${FINDING_ID}/deep-dive`;

describe("POST /api/projects/:projectId/analyses/:id/findings/:findingId/deep-dive", () => {
  it("expands a finding into an issue draft via one LLM call (200)", async () => {
    const res = await request(app).post(url).set("Authorization", `Bearer ${adminToken}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.draft.title).toBe(VALID_DRAFT.title);
    expect(res.body.data.meta.tokensUsed).toBe(180);
    expect(res.body.data.meta.model).toContain("haiku");
    expect(orch.chatMock).toHaveBeenCalledTimes(1);
  });

  it("forwards optional instructions and still makes exactly one call", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ instructions: "Focus on GDPR implications" });

    expect(res.status).toBe(200);
    expect(orch.chatMock).toHaveBeenCalledTimes(1);
    const userMessage = orch.chatMock.mock.calls[0][0][0].content as string;
    expect(userMessage).toContain("GDPR");
  });

  it("rejects an over-long instructions payload (400)", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ instructions: "x".repeat(2001) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(orch.chatMock).not.toHaveBeenCalled();
  });

  it("requires authentication (401)", async () => {
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(401);
  });

  it("forbids users without analysis.run (403)", async () => {
    const res = await request(app).post(url).set("Authorization", `Bearer ${readerToken}`).send({});
    expect(res.status).toBe(403);
    expect(orch.chatMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the finding belongs to a different analysis (IDOR)", async () => {
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/analyses/ana_other/findings/${FINDING_ID}/deep-dive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    // ana_other is not visible → analysis 404
    expect(res.status).toBe(404);
    expect(orch.chatMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the finding does not exist", async () => {
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/analyses/${ANALYSIS_ID}/findings/missing/deep-dive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("FINDING_NOT_FOUND");
    expect(orch.chatMock).not.toHaveBeenCalled();
  });

  it("returns 429 when the monthly token cap is exceeded", async () => {
    costCapShouldThrow = true;
    const res = await request(app).post(url).set("Authorization", `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(429);
    expect(orch.chatMock).not.toHaveBeenCalled();
  });
});
