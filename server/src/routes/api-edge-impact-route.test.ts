/**
 * #2115 — GET /impact-analyses/:id/api-edge-impact: authorized as GET /:id
 * (the run's every project), edges read only on products the caller can read,
 * consumers outside the run named only when the caller can open them. The
 * service is mocked (its own tests cover the walk); Prisma is never touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; role: string } = { userId: "user-1", role: "member" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

let permitRead = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "analysis.read" && !permitRead) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));

const listMemberAccessibleProjectIds = vi.fn(async (_actor: unknown, ids?: string[]) =>
  (ids ?? []).filter((id) => id !== "p-hidden"),
);
vi.mock("../lib/scheduler/project-access.js", () => ({
  isAdminActor: () => false,
  actorHasProjectAccess: vi.fn(async () => true),
  listMemberAccessibleProjectIds,
}));

const loadAccessibleImpactDetail = vi.fn();
vi.mock("../lib/impact-analysis/impact-detail-access.js", () => ({ loadAccessibleImpactDetail }));

const buildProductAccessWhere = vi.fn(async () => ({ OR: [{ id: "readable" }] }));
vi.mock("../lib/products/product-access.js", () => ({ buildProductAccessWhere }));

const apiEdgeImpact = vi.fn();
vi.mock("../lib/cross-project/api-edge-impact.js", () => ({ apiEdgeImpact }));

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../lib/connectors/db/db-service.js", () => ({
  listDbConnectors: vi.fn(),
  inspectDbConnector: vi.fn(),
}));

const { AppError, errorHandler } = await import("../middleware/error-handler.js");
const { impactAnalysisRouter } = await import("./impact-analysis.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/impact-analyses", impactAnalysisRouter());
  app.use(errorHandler);
  return app;
}

describe("GET /impact-analyses/:id/api-edge-impact", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    permitRead = true;
    app = createApp();
  });

  it("computes over the run the caller was admitted to, on readable products", async () => {
    const detail = { id: "ia-1", projectIds: ["p-v2"], items: [] };
    loadAccessibleImpactDetail.mockResolvedValueOnce(detail);
    const result = { impactAnalysisId: "ia-1", consumers: [], untouched: [] };
    apiEdgeImpact.mockResolvedValueOnce(result);

    const res = await request(app).get("/impact-analyses/ia-1/api-edge-impact");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(result);
    expect(loadAccessibleImpactDetail).toHaveBeenCalledWith(
      { id: "user-1", role: "member" },
      "ia-1",
    );
    expect(buildProductAccessWhere).toHaveBeenCalledWith(currentUser);
    const [run, access] = apiEdgeImpact.mock.calls[0] as [
      unknown,
      { readableProjectIds: (ids: string[]) => Promise<string[]>; productWhere: unknown },
    ];
    expect(run).toBe(detail);
    expect(access.productWhere).toEqual({ OR: [{ id: "readable" }] });
    // The readability check is the project-access rule, bounded to the ids asked.
    await expect(access.readableProjectIds(["p-client", "p-hidden"])).resolves.toEqual([
      "p-client",
    ]);
    expect(listMemberAccessibleProjectIds).toHaveBeenCalledWith({ id: "user-1", role: "member" }, [
      "p-client",
      "p-hidden",
    ]);
  });

  it("404 when the caller cannot read the run, and nothing is computed", async () => {
    loadAccessibleImpactDetail.mockRejectedValueOnce(
      new AppError(404, "NOT_FOUND", "Impact analysis not found"),
    );
    const res = await request(app).get("/impact-analyses/ia-x/api-edge-impact");
    expect(res.status).toBe(404);
    expect(apiEdgeImpact).not.toHaveBeenCalled();
  });

  it("403 without analysis.read", async () => {
    permitRead = false;
    const res = await request(app).get("/impact-analyses/ia-1/api-edge-impact");
    expect(res.status).toBe(403);
    expect(loadAccessibleImpactDetail).not.toHaveBeenCalled();
  });
});
