/**
 * Route tests for /api/runs (#110, #153) and /api/projects/:id/agents-md (#154).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const {
  findUniqueProject,
  findManyKnown,
  agentRunFindMany,
  agentRunFindUnique,
  sandboxSessionFindMany,
  projectFindMany,
} = vi.hoisted(() => ({
  findUniqueProject: vi.fn(),
  findManyKnown: vi.fn(async () => [] as unknown[]),
  sandboxSessionFindMany: vi.fn(async () => [] as unknown[]),
  projectFindMany: vi.fn(async () => [] as Array<{ id: string }>),
  agentRunFindMany: vi.fn(async () => [
    {
      id: "run_1",
      sessionId: "s1",
      projectId: "p1",
      kind: "analysis",
      status: "completed",
      startedAt: new Date("2026-04-01"),
      completedAt: new Date("2026-04-01"),
      latencyMs: 100,
      totalTokens: 50,
      costCents: 1,
      _count: { steps: 3 },
    },
  ]),
  agentRunFindUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
    where.id === "run_1"
      ? {
          id: "run_1",
          sessionId: "s1",
          projectId: "p1",
          kind: "analysis",
          status: "completed",
          startedAt: new Date("2026-04-01"),
          completedAt: new Date("2026-04-01"),
          latencyMs: 100,
          totalTokens: 50,
          costCents: 1,
          steps: [
            {
              id: "step_1",
              ord: 0,
              kind: "agent_phase",
              content: '{"agentKey":"document"}',
              spanId: null,
              traceId: null,
              latencyMs: null,
              createdAt: new Date(),
            },
          ],
        }
      : null,
  ),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: findUniqueProject, findMany: projectFindMany },
    knownAgentDefinition: { findMany: findManyKnown },
    agentRun: {
      findMany: agentRunFindMany,
      findUnique: agentRunFindUnique,
    },
    sandboxSession: { findMany: sandboxSessionFindMany },
  },
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { runsRouter } from "../src/routes/runs.js";
import { projectAgentsMdRouter } from "../src/routes/agents-md.js";

let adminToken: string;
let developerToken: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/runs", runsRouter());
  app.use("/api/projects/:projectId", projectAgentsMdRouter());
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  adminToken = issueTokens({
    userId: "u1",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
  developerToken = issueTokens({
    userId: "u_dev",
    username: "developer",
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;
});

afterEach(() => {
  findUniqueProject.mockReset();
  findManyKnown.mockReset();
  findManyKnown.mockResolvedValue([]);
});

describe("GET /api/runs", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp()).get("/api/runs");
    expect(res.status).toBe(401);
  });

  it("returns runs list for authenticated user", async () => {
    const res = await request(makeApp())
      .get("/api/runs?projectId=p1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe("run_1");
  });

  it("supports sessionId + from/to filters without 500ing", async () => {
    const res = await request(makeApp())
      .get("/api/runs?sessionId=s1&from=2026-04-01&to=2026-05-01")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/runs/:id and /:id/replay", () => {
  it("returns the run with steps for an existing id", async () => {
    const res = await request(makeApp())
      .get("/api/runs/run_1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.run.id).toBe("run_1");
    expect(res.body.data.steps).toHaveLength(1);
    expect(res.body.data.steps[0].content).toEqual({ agentKey: "document" });
  });

  it("returns 404 when not found", async () => {
    const res = await request(makeApp())
      .get("/api/runs/missing")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("/replay returns same payload", async () => {
    const res = await request(makeApp())
      .get("/api/runs/run_1/replay")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.run.id).toBe("run_1");
  });
});

describe("GET /api/runs/:id/sandbox-sessions (#419)", () => {
  it("returns 404 when the run does not exist (no sandbox data leaks)", async () => {
    const res = await request(makeApp())
      .get("/api/runs/missing/sandbox-sessions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("returns the sandbox session list for an existing run", async () => {
    sandboxSessionFindMany.mockResolvedValueOnce([
      {
        id: "sb_1",
        provider: "e2b",
        vendorSandboxId: "vendor-1",
        templateId: null,
        vCpus: 1,
        memMiB: 1024,
        createdAt: new Date("2026-04-30T12:00:00Z"),
        destroyedAt: new Date("2026-04-30T12:00:30Z"),
        wallClockMs: 30_000,
        costMicroUsd: 690,
        outcome: "completed",
        errorMessage: null,
      },
    ]);
    const res = await request(makeApp())
      .get("/api/runs/run_1/sandbox-sessions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.runId).toBe("run_1");
    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0].provider).toBe("e2b");
    expect(res.body.data.sessions[0].costMicroUsd).toBe(690);
    expect(res.body.data.sessions[0].outcome).toBe("completed");
  });

  it("requires authentication", async () => {
    const res = await request(makeApp()).get("/api/runs/run_1/sandbox-sessions");
    expect(res.status).toBe(401);
  });

  it("returns 403 when a non-admin tries to read sandbox sessions for another tenant's run (#419 IDOR)", async () => {
    // Developer is not the project's creator and not an admin → no access.
    sandboxSessionFindMany.mockClear();
    projectFindMany.mockResolvedValueOnce([]);
    const res = await request(makeApp())
      .get("/api/runs/run_1/sandbox-sessions")
      .set("Authorization", `Bearer ${developerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    // CRITICAL: must not have queried sandbox sessions on a denied run.
    expect(sandboxSessionFindMany).not.toHaveBeenCalled();
  });

  it("returns 200 when the developer owns the parent project", async () => {
    projectFindMany.mockResolvedValueOnce([{ id: "p1" }]);
    sandboxSessionFindMany.mockResolvedValueOnce([]);
    const res = await request(makeApp())
      .get("/api/runs/run_1/sandbox-sessions")
      .set("Authorization", `Bearer ${developerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.runId).toBe("run_1");
  });
});

describe("GET /api/runs/:id RBAC (#419 IDOR)", () => {
  it("returns 403 when a non-admin requests another tenant's run", async () => {
    projectFindMany.mockResolvedValueOnce([]);
    const res = await request(makeApp())
      .get("/api/runs/run_1")
      .set("Authorization", `Bearer ${developerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("/replay is also gated on project access", async () => {
    projectFindMany.mockResolvedValueOnce([]);
    const res = await request(makeApp())
      .get("/api/runs/run_1/replay")
      .set("Authorization", `Bearer ${developerToken}`);
    expect(res.status).toBe(403);
  });

  it("system runs (projectId=null) are admin-only", async () => {
    agentRunFindUnique.mockResolvedValueOnce({
      id: "run_sys",
      sessionId: "s1",
      projectId: null,
      kind: "analysis",
      status: "completed",
      startedAt: new Date(),
      completedAt: null,
      latencyMs: null,
      totalTokens: 0,
      costCents: 0,
      steps: [],
    });
    const res = await request(makeApp())
      .get("/api/runs/run_sys")
      .set("Authorization", `Bearer ${developerToken}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/projects/:id/agents-md", () => {
  it("returns 404 when project missing", async () => {
    findUniqueProject.mockResolvedValue(null);
    const res = await request(makeApp())
      .get("/api/projects/p_missing/agents-md")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("returns markdown body for an existing project", async () => {
    findUniqueProject.mockResolvedValue({
      id: "p1",
      name: "Demo",
      description: "desc",
      aiProviderId: null,
    });
    const res = await request(makeApp())
      .get("/api/projects/p1/agents-md")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("# Demo");
    expect(res.text).toContain("## business-analyst");
  });

  it("/preview returns structured detector JSON", async () => {
    findUniqueProject.mockResolvedValue({
      id: "p1",
      name: "Demo",
      description: "desc",
      aiProviderId: null,
    });
    const res = await request(makeApp())
      .get("/api/projects/p1/agents-md/preview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.agents)).toBe(true);
    expect(res.body.data.agents.length).toBeGreaterThanOrEqual(4);
  });

  it("merges KnownAgentDefinition rows into the structured preview", async () => {
    findUniqueProject.mockResolvedValue({
      id: "p1",
      name: "Demo",
      description: "",
      aiProviderId: null,
    });
    findManyKnown.mockResolvedValue([
      {
        id: "ka_1",
        projectId: "p1",
        source: "agents-md",
        name: "code-reviewer",
        description: "reviews code",
        systemPrompt: "you review",
        tools: '["lint","format"]',
        model: null,
      },
    ]);
    const res = await request(makeApp())
      .get("/api/projects/p1/agents-md/preview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const reviewer = res.body.data.agents.find((a: { name: string }) => a.name === "code-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer.tools).toContain("lint");
  });

  it("falls back to empty tools when KnownAgentDefinition.tools is invalid JSON", async () => {
    findUniqueProject.mockResolvedValue({
      id: "p1",
      name: "Demo",
      description: "",
      aiProviderId: null,
    });
    findManyKnown.mockResolvedValue([
      {
        id: "ka_2",
        projectId: "p1",
        source: "agents-md",
        name: "broken",
        description: "",
        systemPrompt: "",
        tools: "not-json",
        model: null,
      },
    ]);
    const res = await request(makeApp())
      .get("/api/projects/p1/agents-md/preview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const broken = res.body.data.agents.find((a: { name: string }) => a.name === "broken");
    expect(broken).toBeDefined();
    expect(broken.tools).toEqual([]);
  });
});
