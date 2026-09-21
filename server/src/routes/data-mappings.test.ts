/**
 * Requirement ↔ data mappings router + service tests — Epic #889 (#892).
 *
 * Exercises the route layer together with the real service module (Prisma
 * mocked) so a single suite covers: happy paths, RBAC denial, validation
 * failure, cross-project/requirement rejection, and duplicate handling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  requirementDataMapping: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  requirement: { findFirst: vi.fn() },
  databaseConnection: { findFirst: vi.fn() },
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: { userId: string } }).user = { userId: "user-1" };
    next();
  },
}));

let permitWrite = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "connector.write" && !permitWrite) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));

const { dataMappingsRouter } = await import("./data-mappings.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId", dataMappingsRouter());
  app.use(errorHandler);
  return app;
}

const ROW = {
  id: "map-1",
  requirementId: "req-1",
  dbConnectorId: "db-1",
  schemaName: "public",
  tableName: "users",
  columnName: "email",
  confidence: 0.9,
  source: "manual",
  note: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  dbConnector: { label: "Prod DB" },
};

const BASE = "/projects/proj-1";
const REQ_PATH = `${BASE}/requirements/req-1/data-mappings`;

describe("data-mappings router", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    permitWrite = true;
    app = createApp();
  });

  describe("GET /requirements/:requirementId/data-mappings", () => {
    it("lists mappings with the joined connector label", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.requirementDataMapping.findMany.mockResolvedValue([ROW]);

      const res = await request(app).get(REQ_PATH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: "map-1",
        dbConnectorLabel: "Prod DB",
        tableName: "users",
        columnName: "email",
        confidence: 0.9,
        source: "manual",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("returns 404 when the requirement is not in the project", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue(null);

      const res = await request(app).get(REQ_PATH);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
      expect(mockPrisma.requirementDataMapping.findMany).not.toHaveBeenCalled();
    });
  });

  describe("POST /requirements/:requirementId/data-mappings", () => {
    const body = {
      dbConnectorId: "db-1",
      schemaName: "public",
      tableName: "users",
      columnName: "email",
      confidence: 0.9,
    };

    it("creates a mapping (201)", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.databaseConnection.findFirst.mockResolvedValue({ id: "db-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue(null);
      mockPrisma.requirementDataMapping.create.mockResolvedValue(ROW);

      const res = await request(app).post(REQ_PATH).send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("map-1");
      expect(mockPrisma.requirementDataMapping.create).toHaveBeenCalledOnce();
    });

    it("rejects invalid payloads with 400", async () => {
      const res = await request(app).post(REQ_PATH).send({ dbConnectorId: "db-1" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(mockPrisma.requirement.findFirst).not.toHaveBeenCalled();
    });

    it("returns 404 when the connector is not in the project", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.databaseConnection.findFirst.mockResolvedValue(null);

      const res = await request(app).post(REQ_PATH).send(body);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DB_CONNECTOR_NOT_FOUND");
    });

    it("rejects a duplicate detected by the service-layer guard (409)", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.databaseConnection.findFirst.mockResolvedValue({ id: "db-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue({ id: "dup" });

      const res = await request(app).post(REQ_PATH).send(body);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DATA_MAPPING_EXISTS");
      expect(mockPrisma.requirementDataMapping.create).not.toHaveBeenCalled();
    });

    it("maps a Prisma unique violation (P2002) to a clean 409", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.databaseConnection.findFirst.mockResolvedValue({ id: "db-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue(null);
      mockPrisma.requirementDataMapping.create.mockRejectedValue({ code: "P2002" });

      const res = await request(app).post(REQ_PATH).send(body);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DATA_MAPPING_EXISTS");
    });

    it("denies writes without the connector.write permission (403)", async () => {
      permitWrite = false;

      const res = await request(app).post(REQ_PATH).send(body);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("creates a table-level mapping from a minimal body and applies defaults", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.databaseConnection.findFirst.mockResolvedValue({ id: "db-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue(null);
      mockPrisma.requirementDataMapping.create.mockResolvedValue({
        ...ROW,
        schemaName: null,
        columnName: null,
        dbConnector: null,
      });

      const res = await request(app)
        .post(REQ_PATH)
        .send({ dbConnectorId: "db-1", tableName: "users" });

      expect(res.status).toBe(201);
      expect(res.body.data.dbConnectorLabel).toBeNull();
      expect(res.body.data.schemaName).toBeNull();
      expect(res.body.data.columnName).toBeNull();
      // No optional fields => create called with explicit nulls and no confidence/source override.
      const arg = mockPrisma.requirementDataMapping.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({ schemaName: null, columnName: null, note: null });
      expect(arg.data).not.toHaveProperty("confidence");
      expect(arg.data).not.toHaveProperty("source");
    });

    it("rethrows non-unique Prisma errors as a 500", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.databaseConnection.findFirst.mockResolvedValue({ id: "db-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue(null);
      mockPrisma.requirementDataMapping.create.mockRejectedValue(new Error("db down"));

      const res = await request(app).post(REQ_PATH).send(body);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("DELETE /requirements/:requirementId/data-mappings/:mappingId", () => {
    it("soft-deletes a mapping (204)", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue({ id: "map-1" });
      mockPrisma.requirementDataMapping.update.mockResolvedValue({ id: "map-1" });

      const res = await request(app).delete(`${REQ_PATH}/map-1`);

      expect(res.status).toBe(204);
      expect(mockPrisma.requirementDataMapping.update).toHaveBeenCalledWith({
        where: { id: "map-1" },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it("returns 404 for an unknown / cross-requirement mapping", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.requirementDataMapping.findFirst.mockResolvedValue(null);

      const res = await request(app).delete(`${REQ_PATH}/missing`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DATA_MAPPING_NOT_FOUND");
      expect(mockPrisma.requirementDataMapping.update).not.toHaveBeenCalled();
    });
  });

  describe("GET /data-mappings (project-wide)", () => {
    it("lists every mapping in the project", async () => {
      mockPrisma.requirementDataMapping.findMany.mockResolvedValue([ROW]);

      const res = await request(app).get(`${BASE}/data-mappings`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(mockPrisma.requirementDataMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, requirement: { projectId: "proj-1", deletedAt: null } },
        }),
      );
    });
  });
});
