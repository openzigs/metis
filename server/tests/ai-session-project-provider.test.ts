/**
 * Per-project AI provider override at session-bind time (issue #134).
 *
 * Strategy: same offline-stub setup as ai-routes.test.ts but with the
 * prisma.project mock returning a project that carries an aiProviderId.
 * The session row should pick up the override instead of falling back to
 * loadAIConfig().provider.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

type Session = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  provider: string;
  model: string;
  policy: string;
  status: string;
  providerSecretRef: string | null;
  scopeProjectIds: string | null;
  scopeWorkspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

const sessions: Session[] = [];
type ProjectRow = {
  id: string;
  aiProviderId: string | null;
  aiModel: string | null;
  deletedAt: Date | null;
  /** #2238 — a project in a workspace the caller is not in cannot be reached. */
  workspaceId?: string | null;
};
const projectsById = new Map<string, ProjectRow>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    aISession: {
      create: vi.fn(async ({ data }: { data: Partial<Session> }) => {
        const row: Session = {
          id: `sess_${sessions.length + 1}`,
          userId: data.userId!,
          projectId: data.projectId ?? null,
          title: data.title ?? "New Chat",
          provider: data.provider!,
          model: data.model!,
          policy: data.policy ?? "{}",
          status: "active",
          providerSecretRef: data.providerSecretRef ?? null,
          scopeProjectIds: data.scopeProjectIds ?? null,
          scopeWorkspaceId: data.scopeWorkspaceId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        sessions.push(row);
        return row;
      }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
    },
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = projectsById.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
      // #304 — `assertProjectAccess` reads the project's workspace. These rows
      // carry none (a pre-workspace project), so every caller may reach them.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = projectsById.get(where.id);
        if (!p) return null;
        return p.workspaceId
          ? { workspaceId: p.workspaceId, workspace: { deletedAt: null, members: [] } }
          : { workspaceId: null };
      }),
      // #2238 — the live-row read of a multi-product scope.
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .map((id) => projectsById.get(id))
          .filter((p): p is ProjectRow => Boolean(p && !p.deletedAt))
          .map((p) => ({ id: p.id })),
      ),
    },
    aITokenUsage: { create: vi.fn(async () => ({})) },
    aIToolApproval: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

// #2238 — the caller's workspaces: "w-mine" only.
vi.mock("../src/lib/cross-project/cross-project-access.js", async () => {
  const { AppError } = await import("../src/middleware/error-handler.js");
  return {
    listMemberProjectsInWorkspace: vi.fn(async (_actor: unknown, workspaceId: string) => {
      if (workspaceId !== "w-mine") throw new AppError(404, "NOT_FOUND", "Workspace not found");
      return ["proj_a"];
    }),
  };
});

vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({ read: vi.fn() }),
  VaultService: class {},
}));

import { aiRouter, setAIProviderForTests } from "../src/routes/ai.js";
import { __resetAIRateLimiter } from "../src/middleware/ai-rate-limit.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { OfflineStubProvider } from "../src/lib/ai/index.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

let token: string;
beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.AI_PROVIDER = "offline-stub";
  process.env.AI_RATE_LIMIT_MAX = "100";
  process.env.AI_RATE_LIMIT_WINDOW_MS = "60000";
  token = issueTokens({
    userId: "user-1",
    username: "alice",
    role: "developer",
    permissions: [],
  }).accessToken;
});

beforeEach(() => {
  sessions.length = 0;
  projectsById.clear();
  setAIProviderForTests(new OfflineStubProvider());
  __resetAIRateLimiter();
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", aiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const auth = (req: request.Test): request.Test => req.set("Authorization", `Bearer ${token}`);

describe("POST /api/ai/sessions per-project provider override", () => {
  it("uses the project's aiProviderId when present", async () => {
    projectsById.set("proj_a", {
      id: "proj_a",
      aiProviderId: "bedrock-gateway",
      aiModel: null,
      deletedAt: null,
    });
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_a" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.provider).toBe("bedrock-gateway");
  });

  it("falls back to the global default when the project has no override", async () => {
    projectsById.set("proj_b", {
      id: "proj_b",
      aiProviderId: null,
      aiModel: null,
      deletedAt: null,
    });
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_b" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.provider).toBe("offline-stub");
  });

  it("falls back to the global default when no project is bound", async () => {
    const res = await auth(request(makeApp()).post("/api/ai/sessions").send({ title: "Demo" }));
    expect(res.status).toBe(201);
    expect(res.body.data.session.provider).toBe("offline-stub");
  });

  it("uses the project's aiModel when no model is in the request body", async () => {
    projectsById.set("proj_m1", {
      id: "proj_m1",
      aiProviderId: null,
      aiModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      deletedAt: null,
    });
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_m1" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.model).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("explicit body.model wins over the project's aiModel override", async () => {
    projectsById.set("proj_m2", {
      id: "proj_m2",
      aiProviderId: null,
      aiModel: "project-default-model",
      deletedAt: null,
    });
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({
        title: "Demo",
        projectId: "proj_m2",
        model: "request-override-model",
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.model).toBe("request-override-model");
  });

  it("falls back to global default model when project.aiModel is null", async () => {
    projectsById.set("proj_m3", {
      id: "proj_m3",
      aiProviderId: null,
      aiModel: null,
      deletedAt: null,
    });
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_m3" }),
    );
    expect(res.status).toBe(201);
    // offline-stub provider's default model id
    expect(typeof res.body.data.session.model).toBe("string");
    expect(res.body.data.session.model.length).toBeGreaterThan(0);
  });
});

describe("POST /api/ai/sessions stale project scope degrades gracefully", () => {
  it("creates an unscoped session (201, no FK error) when body.projectId no longer resolves", async () => {
    // No project seeded — mirrors a stale client scope (deleted project or a
    // reset local DB) whose id would otherwise violate the FK on create.
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_gone" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(res.body.data.session.provider).toBe("offline-stub");
  });

  it("drops a single-element projectIds scope that no longer resolves", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_gone"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
  });

  it("binds a valid single-element projectIds scope", async () => {
    projectsById.set("proj_ok", {
      id: "proj_ok",
      aiProviderId: null,
      aiModel: null,
      deletedAt: null,
    });
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_ok"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBe("proj_ok");
  });
});

describe("POST /api/ai/sessions scope metadata (#607)", () => {
  const seed = (id: string) =>
    projectsById.set(id, { id, aiProviderId: null, aiModel: null, deletedAt: null });

  // #2238 — a 2+ projectIds scope is no longer degraded: the session keeps it.
  it("keeps a 2+ projectIds scope as a multi-product session", async () => {
    seed("proj_a");
    seed("proj_b");
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_a", "proj_b", "proj_a"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(JSON.parse(sessions[0].scopeProjectIds!)).toEqual(["proj_a", "proj_b"]);
    // The client reads the scope as a list, as the resume read returns it.
    expect(res.body.data.session.scopeProjectIds).toEqual(["proj_a", "proj_b"]);
    expect(sessions[0].scopeWorkspaceId).toBeNull();
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_a", "proj_b"],
      appliedProjectId: null,
      appliedProjectIds: ["proj_a", "proj_b"],
      appliedWorkspaceId: null,
      degraded: false,
    });
  });

  it("degrades a multi-product scope naming a project the caller cannot reach, binding none of it (#2440)", async () => {
    seed("proj_a");
    projectsById.set("proj_x", {
      id: "proj_x",
      aiProviderId: null,
      aiModel: null,
      deletedAt: null,
      workspaceId: "w-other",
    });
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_a", "proj_x"] }),
    );
    expect(res.status).toBe(201);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectId).toBeNull();
    expect(sessions[0].scopeProjectIds).toBeNull();
    expect(res.body.data.scope).toMatchObject({ degraded: true, reason: "stale-project" });
  });

  it("scopes a session to a workspace the caller is in", async () => {
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", workspaceId: "w-mine" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(sessions[0].scopeWorkspaceId).toBe("w-mine");
    expect(sessions[0].scopeProjectIds).toBeNull();
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: [],
      appliedProjectId: null,
      appliedProjectIds: [],
      appliedWorkspaceId: "w-mine",
      degraded: false,
    });
  });

  it("refuses (404) a workspace the caller is not in, creating nothing", async () => {
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", workspaceId: "w-other" }),
    );
    expect(res.status).toBe(404);
    expect(sessions).toHaveLength(0);
  });

  it("refuses (400) a scope naming both projects and a workspace", async () => {
    seed("proj_a");
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectId: "proj_a", workspaceId: "w-mine" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SCOPE_CONFLICT");
    expect(sessions).toHaveLength(0);
  });

  it("returns non-degraded scope metadata when exactly one valid id is sent", async () => {
    seed("proj_a");
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_a"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBe("proj_a");
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_a"],
      appliedProjectId: "proj_a",
      appliedProjectIds: ["proj_a"],
      appliedWorkspaceId: null,
      degraded: false,
    });
  });

  it("degrades a mixed valid + stale multi-id scope as stale-project (#2238)", async () => {
    seed("proj_a"); // valid — proj_gone is never seeded
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_a", "proj_gone"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(sessions[0].scopeProjectIds).toBeNull();
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_a", "proj_gone"],
      appliedProjectId: null,
      appliedProjectIds: [],
      appliedWorkspaceId: null,
      degraded: true,
      reason: "stale-project",
    });
  });

  it("reports stale-project degradation for a single stale projectIds entry (regression 1c06c4d)", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_gone"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_gone"],
      appliedProjectId: null,
      appliedProjectIds: [],
      appliedWorkspaceId: null,
      degraded: true,
      reason: "stale-project",
    });
  });

  it("reports stale-project degradation for a stale body.projectId", async () => {
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_gone" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_gone"],
      appliedProjectId: null,
      appliedProjectIds: [],
      appliedWorkspaceId: null,
      degraded: true,
      reason: "stale-project",
    });
  });

  it("returns non-degraded empty scope metadata for an unscoped request", async () => {
    const res = await auth(request(makeApp()).post("/api/ai/sessions").send({ title: "Demo" }));
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: [],
      appliedProjectId: null,
      appliedProjectIds: [],
      appliedWorkspaceId: null,
      degraded: false,
    });
  });
});

// #2440 — session create must not tell a caller whether a project id it holds
// exists: an unknown id and another workspace's id give the same answer, on the
// single-project path and the multi-product path alike.
describe("POST /api/ai/sessions does not reveal whether an unreachable project exists (#2440)", () => {
  const seedForeign = (id: string, extra: Partial<ProjectRow> = {}) =>
    projectsById.set(id, {
      id,
      aiProviderId: "bedrock-gateway",
      aiModel: "foreign-model",
      deletedAt: null,
      workspaceId: "w-other",
      ...extra,
    });
  const seedMine = (id: string) =>
    projectsById.set(id, { id, aiProviderId: null, aiModel: null, deletedAt: null });

  /** The answer, with the per-row fields and the echoed request ids masked. */
  async function answer(body: Record<string, unknown>) {
    const res = await auth(request(makeApp()).post("/api/ai/sessions").send(body));
    const data = res.body.data ?? {};
    const { id: _id, createdAt: _c, updatedAt: _u, ...session } = data.session ?? {};
    const { requestedProjectIds: _r, ...scope } = data.scope ?? {};
    return { status: res.status, error: res.body.error ?? null, session, scope };
  }

  const shapes: Array<{ name: string; body: (id: string) => Record<string, unknown> }> = [
    { name: "projectId", body: (id) => ({ title: "Demo", projectId: id }) },
    { name: "a single projectIds entry", body: (id) => ({ title: "Demo", projectIds: [id] }) },
    {
      name: "a multi-product projectIds scope",
      body: (id) => ({ title: "Demo", projectIds: ["proj_a", id] }),
    },
  ];
  for (const shape of shapes) {
    it(`answers an unknown id and another workspace's id identically via ${shape.name}`, async () => {
      seedMine("proj_a");
      seedForeign("proj_foreign");
      const unknown = await answer(shape.body("proj_never_existed"));
      const foreign = await answer(shape.body("proj_foreign"));
      expect(foreign).toEqual(unknown);
      expect(foreign.status).toBe(201);
      expect(foreign.scope).toMatchObject({ degraded: true, reason: "stale-project" });
      // #304 still holds: nothing of the foreign project is bound — not the
      // project, not its scope, not its provider or model override.
      expect(sessions).toHaveLength(2);
      for (const row of sessions) {
        expect(row.projectId).toBeNull();
        expect(row.scopeProjectIds).toBeNull();
        expect(row.provider).toBe("offline-stub");
        expect(row.model).not.toBe("foreign-model");
      }
    });
  }

  it("answers a soft-deleted project of another workspace the same as an unknown id", async () => {
    seedForeign("proj_foreign_gone", { deletedAt: new Date() });
    const unknown = await answer({ title: "Demo", projectId: "proj_never_existed" });
    const gone = await answer({ title: "Demo", projectId: "proj_foreign_gone" });
    expect(gone).toEqual(unknown);
  });

  it("does not read the project row (provider / model override) of an unreachable project", async () => {
    seedForeign("proj_foreign");
    const { prisma } = await import("../src/lib/prisma.js");
    await answer({ title: "Demo", projectId: "proj_foreign" });
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it("still fails loudly (500) when the access read itself errors, creating nothing", async () => {
    seedMine("proj_a");
    const { prisma } = await import("../src/lib/prisma.js");
    vi.mocked(prisma.project.findUnique).mockRejectedValueOnce(new Error("db down"));
    const res = await auth(
      request(makeApp()).post("/api/ai/sessions").send({ title: "Demo", projectId: "proj_a" }),
    );
    expect(res.status).toBe(500);
    expect(sessions).toHaveLength(0);
  });
});
