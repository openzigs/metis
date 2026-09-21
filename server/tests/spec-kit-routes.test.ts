/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the `/api/projects/:projectId/spec-kit/*` route surface.
 * Mounts the router on a stand-alone Express app with stubbed auth so we
 * exercise zod validation, dispatch, and error normalisation without
 * standing up the full server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      userId: "u1",
      username: "tester",
      role: authRole.value,
      permissions: ["*"],
    };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const authRole = vi.hoisted(() => ({ value: "admin" as string }));
const projectFlag = vi.hoisted(() => ({ enabled: true, exists: true }));

vi.mock("../src/lib/spec-kit/artifacts.js", async () => {
  const store = new Map<string, any>();
  let id = 0;
  function dto(row: any): any {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      content: row.content,
      version: row.version,
      updatedById: row.updatedById,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  class SpecKitArtifactError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const NAMES = new Set([
    "spec.md",
    "plan.md",
    "tasks.md",
    "constitution.md",
    "clarify.md",
    "analysis.md",
  ]);
  return {
    SpecKitArtifactError,
    isSpecKitEnabled: vi.fn(async () => {
      if (!projectFlag.exists) {
        throw new SpecKitArtifactError(404, "PROJECT_NOT_FOUND", "missing");
      }
      return projectFlag.enabled;
    }),
    setSpecKitEnabled: vi.fn(async (_p: string, enabled: boolean) => {
      projectFlag.enabled = enabled;
      return enabled;
    }),
    listArtifacts: vi.fn(async (projectId: string) =>
      [...store.values()].filter((r) => r.projectId === projectId).map(dto),
    ),
    getArtifact: vi.fn(async (projectId: string, name: string) => {
      if (!NAMES.has(name)) {
        throw new SpecKitArtifactError(400, "SPEC_KIT_INVALID_NAME", `unknown ${name}`);
      }
      for (const r of store.values()) {
        if (r.projectId === projectId && r.name === name) return dto(r);
      }
      return null;
    }),
    writeArtifact: vi.fn(async ({ projectId, name, content, actorId }: any) => {
      if (!NAMES.has(name)) {
        throw new SpecKitArtifactError(400, "SPEC_KIT_INVALID_NAME", `unknown ${name}`);
      }
      id++;
      const row = {
        id: `ska_${id}`,
        projectId,
        name,
        content,
        version: 1,
        updatedById: actorId ?? null,
      };
      store.set(row.id, row);
      return dto(row);
    }),
    deleteArtifact: vi.fn(async () => undefined),
    __store: store,
  };
});

vi.mock("../src/lib/spec-kit/constitution.js", () => ({
  generateConstitution: vi.fn(async () => "# Project Constitution\n... body ..."),
}));

// #381 — the route resolves the project's REAL provider and threads it into
// the command runners via `deps.provider`. We mock the resolver so the test
// gets a deterministic, identity-checkable provider object (no DB / SDK).
const fakeProvider = vi.hoisted(() => ({ key: "anthropic", chat: vi.fn(), stream: vi.fn() }));
const resolveProjectProvider = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/ai/project-provider.js", () => ({
  resolveProjectProvider,
}));

const stubResult = (cmd: string) => ({
  artifact: {
    id: "ska_x",
    projectId: "p1",
    name: cmd === "implement" ? null : `${cmd}.md`,
    content: "ok",
    version: 1,
    updatedById: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  questioned: false,
  verdict: "OK",
  context: ["spec.md"],
  orchestratorRoute: "/api/projects/p1/analyses",
  tokensUsed: 1,
  message: "ok",
});

vi.mock("../src/lib/spec-kit/commands/specify.js", () => ({
  runSpecify: vi.fn(async () => stubResult("spec")),
}));
vi.mock("../src/lib/spec-kit/commands/plan.js", () => ({
  runPlan: vi.fn(async () => stubResult("plan")),
}));
vi.mock("../src/lib/spec-kit/commands/tasks.js", () => ({
  runTasks: vi.fn(async () => stubResult("tasks")),
}));
vi.mock("../src/lib/spec-kit/commands/clarify.js", () => ({
  runClarify: vi.fn(async () => stubResult("clarify")),
}));
vi.mock("../src/lib/spec-kit/commands/analyze.js", () => ({
  runAnalyze: vi.fn(async () => stubResult("analysis")),
}));
vi.mock("../src/lib/spec-kit/commands/implement.js", () => ({
  runImplement: vi.fn(async () => stubResult("implement")),
}));
vi.mock("../src/lib/spec-kit/commands/constitution.js", () => ({
  runConstitution: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/lib/spec-kit/commands/specify-feature.js", () => ({
  runSpecifyFeature: vi.fn(async () => ({
    feature: { slug: "001-x" },
    artifact: {},
    message: "ok",
    tokensUsed: 0,
  })),
}));
vi.mock("../src/lib/spec-kit/commands/plan-expanded.js", () => ({
  runPlanExpanded: vi.fn(async () => ({ artifacts: [], message: "ok", tokensUsed: 0 })),
}));
vi.mock("../src/lib/spec-kit/commands/checklist.js", () => ({
  runChecklist: vi.fn(async () => ({ artifacts: [], domains: [], message: "ok" })),
}));
vi.mock("../src/lib/spec-kit/commands/taskstoissues.js", () => ({
  runTasksToIssues: vi.fn(async () => ({
    count: 0,
    created: [],
    repo: { owner: "o", name: "r" },
    parentEpicNumber: null,
    message: "ok",
  })),
}));

const featureLifecycle = vi.hoisted(() => {
  class SpecKitFeatureLifecycleError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "SpecKitFeatureLifecycleError";
    }
  }
  return {
    SpecKitFeatureLifecycleError,
    archiveFeature: vi.fn(),
    restoreFeature: vi.fn(),
    listFeatures: vi.fn(),
    resolveFeatureBySlug: vi.fn(),
  };
});

vi.mock("../src/lib/spec-kit/features.js", () => ({
  archiveFeature: featureLifecycle.archiveFeature,
  restoreFeature: featureLifecycle.restoreFeature,
  listFeatures: featureLifecycle.listFeatures,
  resolveFeatureBySlug: featureLifecycle.resolveFeatureBySlug,
  SpecKitFeatureLifecycleError: featureLifecycle.SpecKitFeatureLifecycleError,
}));

import express from "express";
import request from "supertest";
import { specKitRouter } from "../src/routes/spec-kit.js";
import { errorHandler } from "../src/middleware/error-handler.js";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/spec-kit", specKitRouter());
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  projectFlag.enabled = true;
  projectFlag.exists = true;
  authRole.value = "admin";
  resolveProjectProvider.mockReset();
  resolveProjectProvider.mockResolvedValue(fakeProvider);
});

afterEach(() => vi.clearAllMocks());

describe("/api/projects/:projectId/spec-kit", () => {
  it("GET /enabled returns the flag", async () => {
    const res = await request(makeApp()).get("/api/projects/p1/spec-kit/enabled");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { enabled: true } });
  });

  it("GET /enabled returns 404 when project missing", async () => {
    projectFlag.exists = false;
    const res = await request(makeApp()).get("/api/projects/missing/spec-kit/enabled");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PUT /enabled validates payload", async () => {
    const res = await request(makeApp())
      .put("/api/projects/p1/spec-kit/enabled")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("PUT /enabled flips the flag", async () => {
    const res = await request(makeApp())
      .put("/api/projects/p1/spec-kit/enabled")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it("GET /files returns empty when disabled (no artifacts leak)", async () => {
    projectFlag.enabled = false;
    const res = await request(makeApp()).get("/api/projects/p1/spec-kit/files");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: false, artifacts: [] });
  });

  it("GET /files/:name 404s when artifact missing", async () => {
    const res = await request(makeApp()).get("/api/projects/p1/spec-kit/files/spec.md");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SPEC_KIT_NOT_FOUND");
  });

  it("PUT /files/:name writes an artifact", async () => {
    const res = await request(makeApp())
      .put("/api/projects/p1/spec-kit/files/spec.md")
      .send({ content: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.artifact.name).toBe("spec.md");
  });

  it("PUT /files/:name rejects unknown names", async () => {
    const res = await request(makeApp())
      .put("/api/projects/p1/spec-kit/files/evil.sh")
      .send({ content: "x" });
    expect(res.status).toBe(400);
  });

  it("DELETE /files/:name returns 204", async () => {
    const res = await request(makeApp()).delete("/api/projects/p1/spec-kit/files/spec.md");
    expect(res.status).toBe(204);
  });

  it("POST /constitution generates and returns the artifact", async () => {
    // First write the artifact so the GET-back inside the route returns it.
    await request(makeApp())
      .put("/api/projects/p1/spec-kit/files/constitution.md")
      .send({ content: "previous" });
    const res = await request(makeApp()).post("/api/projects/p1/spec-kit/constitution").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.contentLength).toBeGreaterThan(0);
  });

  it("POST /commands/specify dispatches", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "build dashboard" });
    expect(res.status).toBe(200);
    expect(res.body.data.command).toBe("specify");
  });

  it("POST /commands/:cmd 400s on unknown command", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/draw")
      .send({ input: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SPEC_KIT_UNKNOWN_COMMAND");
  });

  it("POST /commands/* returns 409 when spec-kit disabled", async () => {
    projectFlag.enabled = false;
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SPEC_KIT_DISABLED");
  });

  it("POST /commands/implement returns the orchestrator handoff payload", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/implement")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(res.body.data.command).toBe("implement");
    expect(res.body.data.artifactName).toBeNull();
  });

  it.each(["plan", "tasks", "clarify", "analyze"] as const)(
    "POST /commands/%s dispatches",
    async (cmd) => {
      const res = await request(makeApp())
        .post(`/api/projects/p1/spec-kit/commands/${cmd}`)
        .send({ input: "" });
      expect(res.status).toBe(200);
      expect(res.body.data.command).toBe(cmd);
    },
  );

  it("POST /commands rejects oversized input via zod schema", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x".repeat(50_001) });
    expect(res.status).toBe(400);
  });

  it("rethrows BudgetExceededError as AppError", async () => {
    const { runSpecify } = await import("../src/lib/spec-kit/commands/specify.js");
    const { BudgetExceededError } = await import("../src/lib/finops/budget-enforcer.js");
    (runSpecify as any).mockRejectedValueOnce(new BudgetExceededError(1000, 100));
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("rethrows SafetyDeniedError as AppError", async () => {
    const { runSpecify } = await import("../src/lib/spec-kit/commands/specify.js");
    const { SafetyDeniedError } = await import("../src/lib/safety/safety-hook.js");
    (runSpecify as any).mockRejectedValueOnce(new SafetyDeniedError("input", []));
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("SAFETY_DENIED");
  });

  it("POST /install returns 501 until AttachedWorkspace lands (S-2)", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/install")
      .send({
        workspaceRoot: "/tmp/whatever",
        hosts: ["copilot"],
        apiBaseUrl: "https://metis.local",
        consent: true,
      });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("SPECKIT_ATTACHED_WORKSPACE_NOT_IMPLEMENTED");
  });

  it("POST /commands/speckit.constitution requires speckit.constitution.write (S-3)", async () => {
    // developer role lacks speckit.constitution.write — must 403 before dispatch.
    authRole.value = "developer";
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.constitution")
      .send({ input: "We hold these truths …" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message).toContain("speckit.constitution.write");
    const { runConstitution } = await import("../src/lib/spec-kit/commands/constitution.js");
    expect(runConstitution).not.toHaveBeenCalled();
  });

  it("POST /commands/speckit.constitution succeeds for a role that carries the permission (S-3)", async () => {
    // coordinator carries speckit.constitution.write by default.
    authRole.value = "coordinator";
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.constitution")
      .send({ input: "Body" });
    expect(res.status).toBe(200);
    const { runConstitution } = await import("../src/lib/spec-kit/commands/constitution.js");
    expect(runConstitution).toHaveBeenCalled();
  });

  it("X-Speckit-Force header threads force=true into runChecklist (S-5)", async () => {
    const { runChecklist } = await import("../src/lib/spec-kit/commands/checklist.js");
    (runChecklist as any).mockClear();
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.checklist")
      .set("X-Speckit-Force", "1")
      .send({ featureSlug: "001-x" });
    expect(res.status).toBe(200);
    expect(runChecklist).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, featureSlug: "001-x" }),
    );
  });

  it("Without X-Speckit-Force, force=false is passed to runChecklist (S-5)", async () => {
    const { runChecklist } = await import("../src/lib/spec-kit/commands/checklist.js");
    (runChecklist as any).mockClear();
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.checklist")
      .send({ featureSlug: "001-x" });
    expect(res.status).toBe(200);
    expect(runChecklist).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it("X-Speckit-Force threads into runPlanExpanded and runTasksToIssues (S-5)", async () => {
    const { runPlanExpanded } = await import("../src/lib/spec-kit/commands/plan-expanded.js");
    const { runTasksToIssues } = await import("../src/lib/spec-kit/commands/taskstoissues.js");
    (runPlanExpanded as any).mockClear();
    (runTasksToIssues as any).mockClear();
    await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.plan")
      .set("X-Speckit-Force", "1")
      .send({ featureSlug: "001-x" });
    await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.taskstoissues")
      .set("X-Speckit-Force", "1")
      .send({ featureSlug: "001-x", dryRun: true });
    expect(runPlanExpanded).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(runTasksToIssues).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });
});

// #381 — the dispatch layer must inject the project's REAL provider into the
// command runners (no silent offline-stub fallback), for BOTH the legacy
// `dispatchCommand` path and the v1.3 `dispatchNamespaced` path.
describe("/api/projects/:projectId/spec-kit provider injection (#381)", () => {
  it("legacy /commands/specify injects the resolved provider", async () => {
    const { runSpecify } = await import("../src/lib/spec-kit/commands/specify.js");
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(200);
    expect(resolveProjectProvider).toHaveBeenCalledWith("p1");
    expect(runSpecify).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("legacy /commands/tasks injects the resolved provider", async () => {
    const { runTasks } = await import("../src/lib/spec-kit/commands/tasks.js");
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/tasks")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(runTasks).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("legacy /commands/clarify injects the resolved provider", async () => {
    const { runClarify } = await import("../src/lib/spec-kit/commands/clarify.js");
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/clarify")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(runClarify).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("legacy /commands/analyze injects the resolved provider", async () => {
    const { runAnalyze } = await import("../src/lib/spec-kit/commands/analyze.js");
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/analyze")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(runAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("legacy /commands/plan injects the resolved provider", async () => {
    const { runPlan } = await import("../src/lib/spec-kit/commands/plan.js");
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/plan")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(runPlan).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("namespaced speckit.specify injects the resolved provider", async () => {
    const { runSpecifyFeature } = await import("../src/lib/spec-kit/commands/specify-feature.js");
    (runSpecifyFeature as any).mockClear();
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.specify")
      .send({ input: "build it" });
    expect(res.status).toBe(200);
    expect(resolveProjectProvider).toHaveBeenCalledWith("p1");
    expect(runSpecifyFeature).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("namespaced speckit.plan injects the resolved provider", async () => {
    const { runPlanExpanded } = await import("../src/lib/spec-kit/commands/plan-expanded.js");
    (runPlanExpanded as any).mockClear();
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.plan")
      .send({ featureSlug: "001-x" });
    expect(res.status).toBe(200);
    expect(runPlanExpanded).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("namespaced speckit.analyze (delegates to dispatchCommand) injects the provider", async () => {
    const { runAnalyze } = await import("../src/lib/spec-kit/commands/analyze.js");
    (runAnalyze as any).mockClear();
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.analyze")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(runAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: fakeProvider } }),
    );
  });

  it("per-project override is honored: resolver decides the provider, route just threads it", async () => {
    // Simulate a project whose override resolves to a different provider.
    const overrideProvider = { key: "openai", chat: vi.fn(), stream: vi.fn() };
    resolveProjectProvider.mockResolvedValueOnce(overrideProvider);
    const { runSpecify } = await import("../src/lib/spec-kit/commands/specify.js");
    (runSpecify as any).mockClear();
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(200);
    expect(runSpecify).toHaveBeenCalledWith(
      expect.objectContaining({ deps: { provider: overrideProvider } }),
    );
  });

  it("provider/credential failure surfaces as 502 AI_PROVIDER_KEY_UNAVAILABLE (no stub fallback)", async () => {
    const { AIProviderError } = await import("../src/lib/ai/errors.js");
    resolveProjectProvider.mockRejectedValueOnce(
      new AIProviderError("Provider credentials unavailable for project: missing key"),
    );
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("AI_PROVIDER_KEY_UNAVAILABLE");
    // The stub must NOT have been used — the runner was never reached.
    const { runSpecify } = await import("../src/lib/spec-kit/commands/specify.js");
    expect(runSpecify).not.toHaveBeenCalled();
  });

  it("namespaced provider failure also surfaces as 502 (dispatchNamespaced path)", async () => {
    const { AIProviderError } = await import("../src/lib/ai/errors.js");
    resolveProjectProvider.mockRejectedValueOnce(new AIProviderError("creds gone"));
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.specify")
      .send({ input: "x" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("AI_PROVIDER_KEY_UNAVAILABLE");
  });

  it("implement does NOT resolve a provider (no LLM call)", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/implement")
      .send({ input: "" });
    expect(res.status).toBe(200);
    expect(resolveProjectProvider).not.toHaveBeenCalled();
  });

  it("speckit.constitution RBAC 403 fires BEFORE provider resolution", async () => {
    // A forbidden caller must get 403 — provider resolution (which could 502)
    // must not run first and mask the authorization error.
    authRole.value = "developer";
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/commands/speckit.constitution")
      .send({ input: "body" });
    expect(res.status).toBe(403);
    expect(resolveProjectProvider).not.toHaveBeenCalled();
  });
});

describe("/api/projects/:projectId/spec-kit feature lifecycle", () => {
  it("GET /features forwards includeArchived=true", async () => {
    featureLifecycle.listFeatures.mockResolvedValueOnce([
      { id: "f1", slug: "001-a", status: "draft" },
    ]);
    const res = await request(makeApp()).get(
      "/api/projects/p1/spec-kit/features?includeArchived=true",
    );
    expect(res.status).toBe(200);
    expect(featureLifecycle.listFeatures).toHaveBeenCalledWith("p1", { includeArchived: true });
    expect(res.body.data.features).toHaveLength(1);
  });

  it("GET /features defaults to includeArchived=false", async () => {
    featureLifecycle.listFeatures.mockResolvedValueOnce([]);
    await request(makeApp()).get("/api/projects/p1/spec-kit/features");
    expect(featureLifecycle.listFeatures).toHaveBeenCalledWith("p1", { includeArchived: false });
  });

  it("POST /features/:slug/archive returns the archived DTO", async () => {
    featureLifecycle.archiveFeature.mockResolvedValueOnce({
      id: "f1",
      slug: "001-x",
      status: "archived",
    });
    const res = await request(makeApp()).post("/api/projects/p1/spec-kit/features/001-x/archive");
    expect(res.status).toBe(200);
    expect(res.body.data.feature.status).toBe("archived");
    expect(featureLifecycle.archiveFeature).toHaveBeenCalledWith({
      projectId: "p1",
      slug: "001-x",
      actorId: "u1",
    });
  });

  it("POST /features/:slug/archive maps SpecKitFeatureLifecycleError to AppError", async () => {
    featureLifecycle.archiveFeature.mockRejectedValueOnce(
      new featureLifecycle.SpecKitFeatureLifecycleError(404, "SPECKIT_FEATURE_NOT_FOUND", "x"),
    );
    const res = await request(makeApp()).post(
      "/api/projects/p1/spec-kit/features/099-missing/archive",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SPECKIT_FEATURE_NOT_FOUND");
  });

  it("POST /features/:slug/restore forwards restoreTo", async () => {
    featureLifecycle.restoreFeature.mockResolvedValueOnce({
      id: "f1",
      slug: "001-x",
      status: "specified",
    });
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/features/001-x/restore")
      .send({ restoreTo: "specified" });
    expect(res.status).toBe(200);
    expect(featureLifecycle.restoreFeature).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", slug: "001-x", restoreTo: "specified" }),
    );
  });

  it("POST /features/:slug/restore omits restoreTo when not provided", async () => {
    featureLifecycle.restoreFeature.mockResolvedValueOnce({
      id: "f1",
      slug: "001-x",
      status: "draft",
    });
    await request(makeApp()).post("/api/projects/p1/spec-kit/features/001-x/restore").send({});
    const callArg = featureLifecycle.restoreFeature.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg).toEqual({ projectId: "p1", slug: "001-x", actorId: "u1" });
    expect("restoreTo" in callArg).toBe(false);
  });

  it("POST /features/:slug/restore rejects invalid restoreTo payload", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/spec-kit/features/001-x/restore")
      .send({ restoreTo: "" });
    expect(res.status).toBe(400);
  });

  it("POST /features/:slug/restore returns 409 when not archived", async () => {
    featureLifecycle.restoreFeature.mockRejectedValueOnce(
      new featureLifecycle.SpecKitFeatureLifecycleError(409, "SPECKIT_FEATURE_NOT_ARCHIVED", "x"),
    );
    const res = await request(makeApp()).post("/api/projects/p1/spec-kit/features/001-x/restore");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SPECKIT_FEATURE_NOT_ARCHIVED");
  });
});
