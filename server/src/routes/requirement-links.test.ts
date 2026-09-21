/**
 * Route tests for the requirement-link REST surface — Epic #610 (#624).
 *
 * Exercises HTTP wiring: permission gating (403 when the coarse key is denied),
 * payload/query validation, status codes, and that the service is invoked with
 * the actor resolved from the session. The service is mocked (it has its own
 * exhaustive authz unit tests); Prisma is mocked so the clean-CI DB is never
 * touched (the #289 lesson).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

let currentUser: { userId: string; role: string } = { userId: "user-1", role: "member" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: Request, _res: Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

let permitPerm = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: (perm: string) => (_req: Request, res: Response, next: NextFunction) => {
    if (!permitPerm) {
      res
        .status(403)
        .json({ success: false, error: { code: "FORBIDDEN", message: `denied ${perm}` } });
      return;
    }
    next();
  },
}));

const createRequirementLink = vi.fn();
const deleteRequirementLink = vi.fn();
const listRequirementLinks = vi.fn();
const searchWorkspaceRequirements = vi.fn();
vi.mock("../lib/requirements/requirement-link-service.js", () => ({
  createRequirementLink: (...a: unknown[]) => createRequirementLink(...a),
  deleteRequirementLink: (...a: unknown[]) => deleteRequirementLink(...a),
  listRequirementLinks: (...a: unknown[]) => listRequirementLinks(...a),
  searchWorkspaceRequirements: (...a: unknown[]) => searchWorkspaceRequirements(...a),
}));
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

const { requirementLinksRouter, requirementLinksResourceRouter, workspaceRequirementSearchRouter } =
  await import("./requirement-links.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/requirements/:requirementId/links", requirementLinksRouter());
  app.use("/requirement-links", requirementLinksResourceRouter());
  app.use("/workspaces/:workspaceId/requirements", workspaceRequirementSearchRouter());
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "user-1", role: "member" };
  permitPerm = true;
});

describe("POST /requirements/:id/links", () => {
  it("creates a link and resolves the actor from the session", async () => {
    createRequirementLink.mockResolvedValue({ id: "link-1", type: "relates_to" });
    const res = await request(createApp())
      .post("/requirements/src/links")
      .send({ targetRequirementId: "tgt", type: "relates_to" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, data: { id: "link-1" } });
    expect(createRequirementLink).toHaveBeenCalledWith(
      {},
      { id: "user-1", role: "member" },
      { sourceRequirementId: "src", targetRequirementId: "tgt", type: "relates_to" },
    );
  });

  it("returns 400 on an invalid link type", async () => {
    const res = await request(createApp())
      .post("/requirements/src/links")
      .send({ targetRequirementId: "tgt", type: "not-a-type" });
    expect(res.status).toBe(400);
    expect(createRequirementLink).not.toHaveBeenCalled();
  });

  it("returns 400 when targetRequirementId is missing", async () => {
    const res = await request(createApp())
      .post("/requirements/src/links")
      .send({ type: "relates_to" });
    expect(res.status).toBe(400);
  });

  it("returns 403 when the coarse permission is denied", async () => {
    permitPerm = false;
    const res = await request(createApp())
      .post("/requirements/src/links")
      .send({ targetRequirementId: "tgt", type: "relates_to" });
    expect(res.status).toBe(403);
    expect(createRequirementLink).not.toHaveBeenCalled();
  });
});

describe("GET /requirements/:id/links", () => {
  it("returns the outgoing + incoming payload", async () => {
    listRequirementLinks.mockResolvedValue({ outgoing: [], incoming: [] });
    const res = await request(createApp()).get("/requirements/req/links");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { outgoing: [], incoming: [] } });
    expect(listRequirementLinks).toHaveBeenCalledWith({}, { id: "user-1", role: "member" }, "req");
  });
});

describe("DELETE /requirement-links/:linkId", () => {
  it("deletes and returns removed:true", async () => {
    deleteRequirementLink.mockResolvedValue(undefined);
    const res = await request(createApp()).delete("/requirement-links/link-1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { removed: true } });
    expect(deleteRequirementLink).toHaveBeenCalledWith(
      {},
      { id: "user-1", role: "member" },
      "link-1",
    );
  });

  it("surfaces a service AppError (403) through the HTTP layer", async () => {
    const { AppError } = await import("../middleware/error-handler.js");
    deleteRequirementLink.mockRejectedValue(new AppError(403, "FORBIDDEN", "no"));
    const res = await request(createApp()).delete("/requirement-links/link-1");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

describe("GET /workspaces/:id/requirements/search", () => {
  it("passes parsed query params to the service", async () => {
    searchWorkspaceRequirements.mockResolvedValue({ items: [], page: 2, pageSize: 5, total: 0 });
    const res = await request(createApp()).get(
      "/workspaces/ws1/requirements/search?q=login&excludeProject=projA&page=2&pageSize=5",
    );
    expect(res.status).toBe(200);
    expect(searchWorkspaceRequirements).toHaveBeenCalledWith(
      { id: "user-1", role: "member" },
      { workspaceId: "ws1", query: "login", excludeProjectId: "projA", page: 2, pageSize: 5 },
      {},
    );
  });

  it("defaults pagination when omitted", async () => {
    searchWorkspaceRequirements.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    await request(createApp()).get("/workspaces/ws1/requirements/search");
    expect(searchWorkspaceRequirements).toHaveBeenCalledWith(
      { id: "user-1", role: "member" },
      { workspaceId: "ws1", query: undefined, excludeProjectId: undefined, page: 1, pageSize: 20 },
      {},
    );
  });

  it("returns 400 on an out-of-range pageSize", async () => {
    const res = await request(createApp()).get("/workspaces/ws1/requirements/search?pageSize=999");
    expect(res.status).toBe(400);
    expect(searchWorkspaceRequirements).not.toHaveBeenCalled();
  });

  it("propagates the 404 from a non-member workspace probe", async () => {
    const { AppError } = await import("../middleware/error-handler.js");
    searchWorkspaceRequirements.mockRejectedValue(
      new AppError(404, "NOT_FOUND", "Workspace not found"),
    );
    const res = await request(createApp()).get("/workspaces/ws-x/requirements/search");
    expect(res.status).toBe(404);
  });
});
