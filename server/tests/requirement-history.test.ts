/**
 * Epic #770 / Issues #772 + #775 — Requirement history / restore / export routes.
 *
 * Exercises pagination, RBAC (restore gated to coordinator+admin), audit
 * emission, and full-history export (CSV + JSON, all versions).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks -----------------------------------------------------------------

const mockPrisma = {
  requirement: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(async () => []) },
  requirementVersion: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  reviewRequestItem: { findMany: vi.fn(async () => []) },
  // #619 — approval gate off by default; gated-export cases flip this.
  project: { findUnique: vi.fn(async () => ({ requireApprovedReview: false })) },
  $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockPrisma)),
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

const auditSpy = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => auditSpy(...args),
}));

// Mutable test-user — mutate `.role` to switch RBAC context between cases.
const testUser = {
  userId: "user-1",
  username: "alice",
  role: "admin" as string,
  permissions: [] as string[],
};

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: typeof testUser }).user = { ...testUser };
    next();
  },
}));

// Faithful RBAC enforcement using the real permission matrix so the
// coordinator/admin gate on restore is genuinely proven.
vi.mock("../src/middleware/require-permission.js", async () => {
  const shared = await vi.importActual<typeof import("@metis/shared")>("@metis/shared");
  const { AppError } = await vi.importActual<typeof import("../src/middleware/error-handler.js")>(
    "../src/middleware/error-handler.js",
  );
  return {
    requirePermission:
      (permission: string) =>
      (req: { user?: { role: string } }, _res: unknown, next: (e?: unknown) => void) => {
        if (!req.user) return next(new AppError(401, "AUTH_REQUIRED", "Authentication required"));
        if (!shared.hasPermission(req.user.role as never, permission as never)) {
          return next(new AppError(403, "FORBIDDEN", `Requires permission ${permission}`));
        }
        next();
      },
  };
});

const { requirementHistoryRouter } = await import("../src/routes/requirement-history.js");

// ---- App factory -----------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/requirements", requirementHistoryRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as {
        statusCode?: number;
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      res.status(e.statusCode ?? 500).json({
        error: { code: e.code ?? "INTERNAL", message: e.message ?? "?", details: e.details },
      });
    },
  );
  return app;
}

const CURRENT = {
  id: "req-1",
  projectId: "proj-1",
  version: 3,
  title: "Title v3",
  body: "Body D",
  priority: "high",
  type: "feature",
  labels: "[]",
  storyPoints: 8,
  reviewStatus: null,
};

const VERSION_ROWS = [
  {
    version: 3,
    changedFields: JSON.stringify({ title: { from: "Title v2", to: "Title v3" } }),
    actorId: "user-9",
    reason: "polish",
    createdAt: new Date("2026-03-03T00:00:00Z"),
  },
  {
    version: 2,
    changedFields: JSON.stringify({ body: { from: "Body C", to: "Body D" } }),
    actorId: "user-8",
    reason: null,
    createdAt: new Date("2026-02-02T00:00:00Z"),
  },
  {
    version: 1,
    changedFields: JSON.stringify({ title: { from: "Title v1", to: "Title v2" } }),
    actorId: "user-7",
    reason: "rename",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
];

// ---- Tests -----------------------------------------------------------------

describe("requirement history router", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    testUser.role = "admin";
    // #619 — restore the default (gate off) implementations that the
    // approval-gate cases override.
    mockPrisma.project.findUnique.mockImplementation(async () => ({
      requireApprovedReview: false,
    }));
    mockPrisma.requirement.findMany.mockImplementation(async () => []);
    mockPrisma.reviewRequestItem.findMany.mockImplementation(async () => []);
    app = createApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /:id/history", () => {
    it("returns a paginated, newest-first timeline with reconstructed snapshots", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);

      const res = await request(app).get("/requirements/req-1/history?page=1&pageSize=2");

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(2);
      expect(res.body.data.currentVersion).toBe(3);
      expect(res.body.data.versions).toHaveLength(2);
      expect(res.body.data.versions[0].version).toBe(3);
      // Snapshot at v1 reconstructs the older title/body.
      const second = await request(app).get("/requirements/req-1/history?page=2&pageSize=2");
      expect(second.body.data.versions).toHaveLength(1);
      expect(second.body.data.versions[0].version).toBe(1);
      expect(second.body.data.versions[0].snapshot.title).toBe("Title v2");
      expect(second.body.data.versions[0].snapshot.body).toBe("Body C");
    });

    it("returns 404 for an unknown requirement", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(null);
      const res = await request(app).get("/requirements/missing/history");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
    });
  });

  describe("GET /:id/history/export", () => {
    it("exports ALL versions as JSON regardless of pagination", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);

      const res = await request(app).get("/requirements/req-1/history/export?format=json&page=2");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.headers["content-disposition"]).toContain("req-1-history.json");
      const body = JSON.parse(res.text);
      expect(body.total).toBe(3);
      expect(body.versions).toHaveLength(3);
    });

    it("exports ALL versions as RFC 4180 CSV", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);

      const res = await request(app).get("/requirements/req-1/history/export?format=csv");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("req-1-history.csv");
      const lines = res.text.split("\r\n");
      // header + 3 data rows
      expect(lines).toHaveLength(4);
      expect(lines[0].startsWith("version,createdAt,actorId,reason,changedFields,title")).toBe(
        true,
      );
      expect(lines[1].startsWith("3,")).toBe(true);
      // changedFields JSON contains a comma → must be quoted.
      expect(res.text).toContain('"{""title"":');
    });

    it("defaults to JSON when no format is given", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);
      const res = await request(app).get("/requirements/req-1/history/export");
      expect(res.headers["content-type"]).toContain("application/json");
    });

    // ---- #619 — approval gate on requirement export -----------------------

    it("blocks export with 409 APPROVAL_REQUIRED when the gate is on and no approved review exists", async () => {
      mockPrisma.project.findUnique.mockImplementation(async () => ({
        requireApprovedReview: true,
      }));
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirement.findMany.mockImplementation(async () => [{ id: "req-1", version: 3 }]);
      mockPrisma.reviewRequestItem.findMany.mockImplementation(async () => []);

      const res = await request(app).get("/requirements/req-1/history/export?format=json");

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
      expect(res.body.error.details.requirementIds).toEqual(["req-1"]);
    });

    it("blocks export when the approval is STALE (pinned v2, requirement now v3)", async () => {
      mockPrisma.project.findUnique.mockImplementation(async () => ({
        requireApprovedReview: true,
      }));
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirement.findMany.mockImplementation(async () => [{ id: "req-1", version: 3 }]);
      mockPrisma.reviewRequestItem.findMany.mockImplementation(async () => [
        { requirementId: "req-1", pinnedVersion: 2 },
      ]);

      const res = await request(app).get("/requirements/req-1/history/export?format=json");

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
    });

    it("allows export when an approved review pins the current version", async () => {
      mockPrisma.project.findUnique.mockImplementation(async () => ({
        requireApprovedReview: true,
      }));
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);
      mockPrisma.requirement.findMany.mockImplementation(async () => [{ id: "req-1", version: 3 }]);
      mockPrisma.reviewRequestItem.findMany.mockImplementation(async () => [
        { requirementId: "req-1", pinnedVersion: 3 },
      ]);

      const res = await request(app).get("/requirements/req-1/history/export?format=json");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.text).total).toBe(3);
    });

    it("FAIL CLOSED: a gate-check error blocks the export with 503", async () => {
      mockPrisma.project.findUnique.mockImplementation(async () => {
        throw new Error("db down");
      });
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);

      const res = await request(app).get("/requirements/req-1/history/export?format=json");

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("APPROVAL_GATE_UNAVAILABLE");
    });
  });

  describe("POST /:id/restore/:version", () => {
    function primeRestore() {
      mockPrisma.requirement.findUnique.mockResolvedValue(CURRENT);
      mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);
      mockPrisma.requirement.update.mockResolvedValue({
        id: "req-1",
        version: 4,
        updatedAt: new Date("2026-04-04T00:00:00Z"),
      });
      mockPrisma.requirementVersion.create.mockResolvedValue({});
    }

    it("restores to a prior version, creating version N+1, and audits", async () => {
      primeRestore();
      const res = await request(app).post("/requirements/req-1/restore/1").send({ reason: "oops" });

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(4);
      expect(res.body.data.restoredFrom).toBe(1);
      // A new version row was appended (never an overwrite).
      expect(mockPrisma.requirementVersion.create).toHaveBeenCalledTimes(1);
      const createArg = mockPrisma.requirementVersion.create.mock.calls[0][0] as {
        data: { version: number };
      };
      expect(createArg.data.version).toBe(4);
      expect(auditSpy).toHaveBeenCalledTimes(1);
      const auditArg = auditSpy.mock.calls[0][0] as { action: string; metadata: unknown };
      expect(auditArg.action).toBe("requirement.restore");
      expect(auditArg.metadata).toMatchObject({ restoredFrom: 1, newVersion: 4 });
    });

    it.each(["developer", "reader"])("forbids restore for role %s", async (role) => {
      testUser.role = role;
      primeRestore();
      const res = await request(app).post("/requirements/req-1/restore/1");
      expect(res.status).toBe(403);
      expect(mockPrisma.requirement.update).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it.each(["coordinator", "admin"])("allows restore for role %s", async (role) => {
      testUser.role = role;
      primeRestore();
      const res = await request(app).post("/requirements/req-1/restore/2");
      expect(res.status).toBe(200);
    });

    it("rejects a non-positive version param with 400", async () => {
      const res = await request(app).post("/requirements/req-1/restore/0");
      expect(res.status).toBe(400);
    });

    it("returns 404 VERSION_NOT_FOUND for an unknown target version", async () => {
      primeRestore();
      const res = await request(app).post("/requirements/req-1/restore/99");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("VERSION_NOT_FOUND");
    });

    it("returns 404 REQUIREMENT_NOT_FOUND when the requirement is missing", async () => {
      mockPrisma.requirement.findUnique.mockResolvedValue(null);
      const res = await request(app).post("/requirements/req-1/restore/1");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
    });
  });
});
