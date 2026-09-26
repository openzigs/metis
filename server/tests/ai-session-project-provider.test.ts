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
    },
    aITokenUsage: { create: vi.fn(async () => ({})) },
    aIToolApproval: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

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

  it("degrades a 2+ projectIds scope to unscoped WITH explicit degradation metadata", async () => {
    seed("proj_a");
    seed("proj_b");
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_a", "proj_b"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_a", "proj_b"],
      appliedProjectId: null,
      degraded: true,
      reason: "multi-project-unsupported",
    });
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
      degraded: false,
    });
  });

  it("degrades a mixed valid + stale multi-id scope as multi-project-unsupported", async () => {
    seed("proj_a"); // valid — proj_gone is never seeded
    const res = await auth(
      request(makeApp())
        .post("/api/ai/sessions")
        .send({ title: "Demo", projectIds: ["proj_a", "proj_gone"] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.session.projectId).toBeNull();
    expect(res.body.data.scope).toEqual({
      requestedProjectIds: ["proj_a", "proj_gone"],
      appliedProjectId: null,
      degraded: true,
      reason: "multi-project-unsupported",
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
      degraded: false,
    });
  });
});
