/**
 * Tests for suggested-connectors routes — Issue #471.
 * Tests the REST API endpoints for suggested connector CRUD.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma before any imports that use it
const mockSuggestedConnectors = new Map<string, Record<string, unknown>>();
let nextId = 0;

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
          id: "user_admin",
          ...create,
        }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    suggestedConnector: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; status?: string } }) => {
        const results: Record<string, unknown>[] = [];
        for (const sc of mockSuggestedConnectors.values()) {
          if (sc.projectId !== where.projectId) continue;
          if (where.status && sc.status !== where.status) continue;
          results.push(sc);
        }
        return results;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) => {
        const sc = mockSuggestedConnectors.get(where.id);
        if (sc && sc.projectId === where.projectId) return sc;
        return null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
          const sc = mockSuggestedConnectors.get(where.id);
          if (!sc) throw new Error("not found");
          const updated = { ...sc, ...data, updatedAt: new Date() };
          mockSuggestedConnectors.set(where.id, updated);
          return updated;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        mockSuggestedConnectors.delete(where.id);
        return { id: where.id };
      }),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function addSuggestion(overrides: Partial<Record<string, unknown>> = {}) {
  nextId++;
  const id = `sc_${nextId}`;
  const sc = {
    id,
    projectId: "proj-1",
    driverType: "postgresql",
    host: "db-host",
    port: 5432,
    database: "mydb",
    sourceFile: "application.properties",
    lineNumber: 10,
    confidence: "high",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mockSuggestedConnectors.set(id, sc);
  return sc;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

describe("suggested-connectors routes", () => {
  beforeEach(async () => {
    mockSuggestedConnectors.clear();
    nextId = 0;
    app = createApp();
    token = await login();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/projects/:projectId/suggested-connectors", () => {
    it("returns empty list when no suggestions", async () => {
      const res = await request(app)
        .get("/api/projects/proj-1/suggested-connectors")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.suggestions).toEqual([]);
      expect(res.body.data.count).toBe(0);
    });

    it("returns all suggestions for project", async () => {
      addSuggestion({ projectId: "proj-1" });
      addSuggestion({ projectId: "proj-1", driverType: "mysql" });
      addSuggestion({ projectId: "proj-2" }); // different project

      const res = await request(app)
        .get("/api/projects/proj-1/suggested-connectors")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);
    });

    it("filters by status", async () => {
      addSuggestion({ projectId: "proj-1", status: "pending" });
      addSuggestion({ projectId: "proj-1", status: "accepted" });
      addSuggestion({ projectId: "proj-1", status: "dismissed" });

      const res = await request(app)
        .get("/api/projects/proj-1/suggested-connectors?status=pending")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.suggestions[0].status).toBe("pending");
    });

    it("requires authentication", async () => {
      const res = await request(app).get("/api/projects/proj-1/suggested-connectors");
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/projects/:projectId/suggested-connectors/:id", () => {
    it("updates status to accepted", async () => {
      const sc = addSuggestion({ projectId: "proj-1" });

      const res = await request(app)
        .patch(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "accepted" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("accepted");
    });

    it("updates status to dismissed", async () => {
      const sc = addSuggestion({ projectId: "proj-1" });

      const res = await request(app)
        .patch(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "dismissed" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("dismissed");
    });

    it("returns 400 for invalid status", async () => {
      const sc = addSuggestion({ projectId: "proj-1" });

      const res = await request(app)
        .patch(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "garbage" });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent suggestion", async () => {
      const res = await request(app)
        .patch("/api/projects/proj-1/suggested-connectors/nonexistent")
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "accepted" });

      expect(res.status).toBe(404);
    });

    it("returns 404 for suggestion in different project", async () => {
      const sc = addSuggestion({ projectId: "proj-2" });

      const res = await request(app)
        .patch(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "accepted" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/projects/:projectId/suggested-connectors/:id", () => {
    it("deletes a suggestion", async () => {
      const sc = addSuggestion({ projectId: "proj-1" });

      const res = await request(app)
        .delete(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
    });

    it("returns 404 for non-existent suggestion", async () => {
      const res = await request(app)
        .delete("/api/projects/proj-1/suggested-connectors/nonexistent")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for suggestion in different project", async () => {
      const sc = addSuggestion({ projectId: "proj-2" });

      const res = await request(app)
        .delete(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });
});
