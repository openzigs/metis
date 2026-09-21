/**
 * Epic #609 (#619) — `/api/projects/:id/review-gate` settings routes.
 *
 * The per-project `requireApprovedReview` flag powers the publish/export
 * approval gate. RBAC under test (real `requirePermission` + shared
 * registry):
 *   - GET requires `project.read` (all roles).
 *   - PATCH requires `review.admin` (coordinator/admin only) — a developer
 *     with draft/publish permissions must NOT be able to weaken the gate.
 * Default under test: a fresh project reports `requireApprovedReview: false`
 * (gate off — pre-#619 behavior).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  requireApprovedReview: boolean;
}

const projects = new Map<string, ProjectRow>();

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
        }) => ({ id: `user_${create.username}`, ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return projects.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { requireApprovedReview: boolean };
        }) => {
          const row = projects.get(where.id);
          if (!row) throw new Error("not found");
          const next = { ...row, ...data };
          projects.set(where.id, next);
          return next;
        },
      ),
    },
  });
  return { prisma };
});

const auditSpy = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => auditSpy(...args),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  projects.clear();
  projects.set("proj_gate_001", { id: "proj_gate_001", requireApprovedReview: false });
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/projects/:id/review-gate", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/projects/proj_gate_001/review-gate");
    expect(res.status).toBe(401);
  });

  it("returns the flag (default false) for any role with project.read", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: false });
  });

  it("404s for an unknown project", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_missing/review-gate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("PATCH /api/projects/:id/review-gate", () => {
  it("admin can enable the gate; the change is audited", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: true });
    expect(projects.get("proj_gate_001")?.requireApprovedReview).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.reviewGate.update",
        target: { type: "project", id: "proj_gate_001" },
        metadata: { requireApprovedReview: true },
      }),
    );
  });

  it("admin can disable the gate again", async () => {
    projects.set("proj_gate_001", { id: "proj_gate_001", requireApprovedReview: true });
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: false });
  });

  it("developer (no review.admin) is rejected with 403 and the flag is untouched", async () => {
    const token = await login("developer");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(403);
    expect(projects.get("proj_gate_001")?.requireApprovedReview).toBe(false);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("reader is rejected with 403", async () => {
    const token = await login("reader");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(403);
  });

  it("rejects a non-boolean payload with 400 VALIDATION_ERROR", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404s for an unknown project", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_missing/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(404);
  });
});
