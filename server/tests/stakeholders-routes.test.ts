/**
 * Tests for stakeholder + project-context API routes — Epic #208 (#230/#233).
 *
 * The service layer is mocked (its own unit tests cover its behaviour); these
 * tests assert routing, Zod validation, status codes, and StakeholderError →
 * AppError mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
const mockList = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();
const mockGetContext = vi.fn();
const mockUpsertContext = vi.fn();
const mockLink = vi.fn();
const mockUnlink = vi.fn();
const mockListForRequirement = vi.fn();

vi.mock("../src/lib/stakeholders/stakeholder-service.js", () => ({
  StakeholderError: class StakeholderError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string) {
      super(message);
      this.name = "StakeholderError";
      this.code = code;
      this.statusCode = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    }
  },
  StakeholderService: class {
    create = mockCreate;
    list = mockList;
    update = mockUpdate;
    remove = mockRemove;
    getContext = mockGetContext;
    upsertContext = mockUpsertContext;
    linkRequirement = mockLink;
    unlinkRequirement = mockUnlink;
    listForRequirement = mockListForRequirement;
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: vi.fn((req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { userId: "user_1", role: "admin" };
    next();
  }),
}));

vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import express from "express";
import type { ErrorRequestHandler } from "express";
import request from "supertest";
import { stakeholdersRouter } from "../src/routes/stakeholders.js";
import { StakeholderError as FakeStakeholderError } from "../src/lib/stakeholders/stakeholder-service.js";
import { AppError } from "../src/middleware/error-handler.js";

const testErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res
      .status(err.statusCode)
      .json({ success: false, error: { code: err.code, message: err.message } });
    return;
  }
  res.status(500).json({ success: false, error: { code: "INTERNAL", message: String(err) } });
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId", stakeholdersRouter());
  app.use(testErrorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("stakeholder CRUD routes", () => {
  it("GET /stakeholders lists", async () => {
    mockList.mockResolvedValueOnce([{ id: "sh1", name: "PO" }]);
    const res = await request(buildApp()).get("/projects/p1/stakeholders");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith("p1");
  });

  it("POST /stakeholders creates and returns 201", async () => {
    mockCreate.mockResolvedValueOnce({ id: "sh1", name: "PO" });
    const res = await request(buildApp())
      .post("/projects/p1/stakeholders")
      .send({ name: "PO", influence: "high" });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("sh1");
    expect(mockCreate).toHaveBeenCalledWith("p1", { name: "PO", influence: "high" });
  });

  it("POST /stakeholders 400s on invalid payload", async () => {
    const res = await request(buildApp()).post("/projects/p1/stakeholders").send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("POST /stakeholders maps a CONFLICT error to 409", async () => {
    mockCreate.mockRejectedValueOnce(new FakeStakeholderError("CONFLICT", "dup"));
    const res = await request(buildApp()).post("/projects/p1/stakeholders").send({ name: "PO" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("POST /stakeholders maps an INVALID error to 400", async () => {
    mockCreate.mockRejectedValueOnce(new FakeStakeholderError("INVALID", "nope"));
    const res = await request(buildApp()).post("/projects/p1/stakeholders").send({ name: "PO" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID");
  });

  it("POST /stakeholders re-throws a non-StakeholderError as 500", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom"));
    const res = await request(buildApp()).post("/projects/p1/stakeholders").send({ name: "PO" });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
  });

  it("POST /stakeholders 400s when no body is sent (req.body ?? {})", async () => {
    const res = await request(buildApp()).post("/projects/p1/stakeholders");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PATCH /stakeholders/:id updates", async () => {
    mockUpdate.mockResolvedValueOnce({ id: "sh1", name: "PO2" });
    const res = await request(buildApp())
      .patch("/projects/p1/stakeholders/sh1")
      .send({ name: "PO2" });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("p1", "sh1", { name: "PO2" });
  });

  it("PATCH /stakeholders/:id 400s on empty patch", async () => {
    const res = await request(buildApp()).patch("/projects/p1/stakeholders/sh1").send({});
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("PATCH /stakeholders/:id maps NOT_FOUND to 404", async () => {
    mockUpdate.mockRejectedValueOnce(new FakeStakeholderError("NOT_FOUND", "missing"));
    const res = await request(buildApp())
      .patch("/projects/p1/stakeholders/sh1")
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("DELETE /stakeholders/:id returns 204", async () => {
    mockRemove.mockResolvedValueOnce(undefined);
    const res = await request(buildApp()).delete("/projects/p1/stakeholders/sh1");
    expect(res.status).toBe(204);
    expect(mockRemove).toHaveBeenCalledWith("p1", "sh1");
  });

  it("DELETE /stakeholders/:id maps NOT_FOUND to 404", async () => {
    mockRemove.mockRejectedValueOnce(new FakeStakeholderError("NOT_FOUND", "missing"));
    const res = await request(buildApp()).delete("/projects/p1/stakeholders/sh1");
    expect(res.status).toBe(404);
  });
});

describe("project context routes", () => {
  it("GET /context reads", async () => {
    mockGetContext.mockResolvedValueOnce({
      businessGoals: "g",
      inScope: [],
      outOfScope: [],
      constraints: [],
      glossary: [],
    });
    const res = await request(buildApp()).get("/projects/p1/context");
    expect(res.status).toBe(200);
    expect(res.body.data.businessGoals).toBe("g");
  });

  it("PUT /context upserts", async () => {
    mockUpsertContext.mockResolvedValueOnce({
      businessGoals: "g",
      inScope: ["a"],
      outOfScope: [],
      constraints: [],
      glossary: [],
    });
    const res = await request(buildApp())
      .put("/projects/p1/context")
      .send({ businessGoals: "g", inScope: ["a"] });
    expect(res.status).toBe(200);
    expect(mockUpsertContext).toHaveBeenCalledWith("p1", { businessGoals: "g", inScope: ["a"] });
  });

  it("PUT /context 400s on invalid payload", async () => {
    const res = await request(buildApp())
      .put("/projects/p1/context")
      .send({ glossary: [{ term: "", definition: "" }] });
    expect(res.status).toBe(400);
    expect(mockUpsertContext).not.toHaveBeenCalled();
  });

  it("PUT /context accepts an empty body via the req.body default", async () => {
    mockUpsertContext.mockResolvedValueOnce({
      businessGoals: "",
      inScope: [],
      outOfScope: [],
      constraints: [],
      glossary: [],
    });
    const res = await request(buildApp()).put("/projects/p1/context");
    expect(res.status).toBe(200);
    expect(mockUpsertContext).toHaveBeenCalledWith("p1", {});
  });
});

describe("requirement ↔ stakeholder routes", () => {
  it("GET /requirements/:id/stakeholders lists links", async () => {
    mockListForRequirement.mockResolvedValueOnce([
      { id: "sh1", name: "PO", priority: "must-have" },
    ]);
    const res = await request(buildApp()).get("/projects/p1/requirements/req1/stakeholders");
    expect(res.status).toBe(200);
    expect(mockListForRequirement).toHaveBeenCalledWith("p1", "req1");
  });

  it("POST /requirements/:id/stakeholders attributes (204)", async () => {
    mockLink.mockResolvedValueOnce(undefined);
    const res = await request(buildApp())
      .post("/projects/p1/requirements/req1/stakeholders")
      .send({ stakeholderId: "sh1", priority: "must-have" });
    expect(res.status).toBe(204);
    expect(mockLink).toHaveBeenCalledWith("p1", "req1", {
      stakeholderId: "sh1",
      priority: "must-have",
    });
  });

  it("POST /requirements/:id/stakeholders 400s without stakeholderId", async () => {
    const res = await request(buildApp())
      .post("/projects/p1/requirements/req1/stakeholders")
      .send({ priority: "must-have" });
    expect(res.status).toBe(400);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("POST /requirements/:id/stakeholders 400s when no body is sent", async () => {
    const res = await request(buildApp()).post("/projects/p1/requirements/req1/stakeholders");
    expect(res.status).toBe(400);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("POST /requirements/:id/stakeholders maps NOT_FOUND to 404", async () => {
    mockLink.mockRejectedValueOnce(new FakeStakeholderError("NOT_FOUND", "missing"));
    const res = await request(buildApp())
      .post("/projects/p1/requirements/req1/stakeholders")
      .send({ stakeholderId: "sh1" });
    expect(res.status).toBe(404);
  });

  it("DELETE /requirements/:id/stakeholders/:sid detaches (204)", async () => {
    mockUnlink.mockResolvedValueOnce(undefined);
    const res = await request(buildApp()).delete("/projects/p1/requirements/req1/stakeholders/sh1");
    expect(res.status).toBe(204);
    expect(mockUnlink).toHaveBeenCalledWith("p1", "req1", "sh1");
  });

  it("DELETE /requirements/:id/stakeholders/:sid maps NOT_FOUND to 404", async () => {
    mockUnlink.mockRejectedValueOnce(new FakeStakeholderError("NOT_FOUND", "missing"));
    const res = await request(buildApp()).delete("/projects/p1/requirements/req1/stakeholders/sh1");
    expect(res.status).toBe(404);
  });
});
