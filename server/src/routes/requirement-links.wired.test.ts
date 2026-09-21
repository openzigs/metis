/**
 * Wired integration test for the requirement-link search route — Epic #610 (#624).
 *
 * Unlike `requirement-links.test.ts`, this suite does NOT mock the service: it
 * drives the FULL route → `searchWorkspaceRequirements` → Prisma path so a
 * broken wiring argument (route forgetting to hand the service its Prisma
 * client) surfaces as a real 500, not a green mock. This is the regression that
 * shipped uncaught: the route omitted `prisma`, the service dereferenced
 * `undefined`, and every legitimate search 500'd. Only `../lib/prisma.js` is
 * mocked (the #289 clean-CI-DB lesson); the service and its cross-project access
 * dependency run for real against that in-memory client.
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

vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// A hand-rolled in-memory Prisma double covering every model the real service +
// its cross-project access guard touch for a non-admin member's search.
const prismaMock = {
  workspaceMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  project: {
    findMany: vi.fn(),
  },
  requirement: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  requirementLink: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
};
// Search now branches on the runtime adapter scheme (#649): keep this wired test
// on the SQLite builder path so the `requirement.count`/`findMany` assertions
// below still exercise the real Prisma query shape.
vi.mock("../lib/prisma.js", () => ({
  prisma: prismaMock,
  resolveDatabaseProvider: () => "sqlite",
}));

const { workspaceRequirementSearchRouter } = await import("./requirement-links.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/workspaces/:workspaceId/requirements", workspaceRequirementSearchRouter());
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "user-1", role: "member" };
  // Non-admin member OF the workspace.
  prismaMock.workspaceMember.findUnique.mockResolvedValue({ id: "wm-1" });
  // One accessible project owned by the caller inside the workspace.
  prismaMock.project.findMany.mockResolvedValue([{ id: "projA", createdById: "user-1" }]);
  prismaMock.requirement.count.mockResolvedValue(1);
  prismaMock.requirement.findMany.mockResolvedValue([
    { id: "r1", title: "Login flow", projectId: "projA", project: { name: "Project A" } },
  ]);
});

describe("GET /workspaces/:id/requirements/search (wired route → service → prisma)", () => {
  it("returns matching requirements when the route wires prisma to the service", async () => {
    const res = await request(createApp()).get(
      "/workspaces/ws1/requirements/search?q=login&page=1&pageSize=20",
    );
    // Pre-fix this 500'd because the route never passed prisma and the service
    // dereferenced an undefined client at `database.requirement.count`.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { items: [{ id: "r1", projectName: "Project A" }], total: 1 },
    });
    // The service actually reached Prisma — proving the client was threaded end
    // to end, not defaulted around a mock.
    expect(prismaMock.requirement.count).toHaveBeenCalledTimes(1);
    expect(prismaMock.requirement.findMany).toHaveBeenCalledTimes(1);
    const whereArg = prismaMock.requirement.findMany.mock.calls[0][0].where;
    expect(whereArg.projectId).toEqual({ in: ["projA"] });
  });
});
