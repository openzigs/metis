/**
 * Object-level authorization tests for products-multi — Issue #677
 * (epic #671, OWASP A01 / BOLA).
 *
 * Unlike products-multi.test.ts (handler-behaviour, admin caller), this suite
 * drives the REAL `requirePermission`, `assertProductAccessible`,
 * `assertProjectAccess`, `listAccessibleProjectIds`, and global `errorHandler`
 * against a mocked Prisma so the tenant-scoping is exercised end-to-end:
 *   (a) a cross-tenant caller gets 404 on by-id reads + sub-resources
 *   (b) GET / and GET /repo-connections only surface caller-accessible rows
 *   (c) an in-tenant caller succeeds
 *   (d) a caller whose role lacks project.read is blocked by the permission layer
 *   (e) an admin sees everything
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AuthPayload } from "@metis/shared";
import type { RoleKey } from "@metis/shared";

// --- configurable authenticated caller -------------------------------------
let currentUser: AuthPayload;
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: unknown, next: () => void) => {
    (req as unknown as { user: AuthPayload }).user = currentUser;
    next();
  },
}));

// --- product-service is spied so we can assert the list access filter and,
// for the write-side BOLA regression tests, that a cross-tenant mutation never
// reaches the service layer.
const mockListProducts = vi.fn();
const mockGetProduct = vi.fn();
const mockUpdateProduct = vi.fn();
const mockDeleteProduct = vi.fn();
const mockAddProductRepo = vi.fn();
const mockRemoveProductRepo = vi.fn();
const mockUpdateProductRepo = vi.fn();
class MockProductError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProductError";
    this.status = status;
    this.code = code;
  }
}
vi.mock("../lib/products/product-service.js", () => ({
  listProducts: (...args: unknown[]) => mockListProducts(...args),
  getProduct: (...args: unknown[]) => mockGetProduct(...args),
  updateProduct: (...args: unknown[]) => mockUpdateProduct(...args),
  deleteProduct: (...args: unknown[]) => mockDeleteProduct(...args),
  addProductRepo: (...args: unknown[]) => mockAddProductRepo(...args),
  removeProductRepo: (...args: unknown[]) => mockRemoveProductRepo(...args),
  updateProductRepo: (...args: unknown[]) => mockUpdateProductRepo(...args),
  // Unused by these tests but referenced by the router import surface.
  createProduct: vi.fn(),
  ProductError: MockProductError,
}));

// --- Prisma mock: models a two-tenant world --------------------------------
// proj-mine (workspace ws-mine, owned by u-mine) vs proj-foreign (ws-foreign).
// p-mine is bound to proj-mine via a repo-connection; p-foreign to proj-foreign.
const REPO_CONNECTIONS = [
  {
    id: "rc-mine",
    projectId: "proj-mine",
    label: "mine",
    provider: "github",
    ownerOrOrg: "o",
    repoName: "mine",
    defaultBranch: "main",
    status: "connected",
  },
  {
    id: "rc-foreign",
    projectId: "proj-foreign",
    label: "foreign",
    provider: "github",
    ownerOrOrg: "o",
    repoName: "foreign",
    defaultBranch: "main",
    status: "connected",
  },
];

const mockPrisma = {
  product: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === "p-mine")
        return { projects: [], repos: [{ repoConnection: { projectId: "proj-mine" } }] };
      if (where.id === "p-foreign")
        return { projects: [], repos: [{ repoConnection: { projectId: "proj-foreign" } }] };
      return null;
    }),
  },
  project: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === "proj-mine") return { workspaceId: "ws-mine" };
      if (where.id === "proj-foreign") return { workspaceId: "ws-foreign" };
      return null;
    }),
    // listAccessibleProjectIds: admin → all; non-admin → ownership (createdById).
    findMany: vi.fn(async ({ where }: { where: { createdById?: string } }) => {
      if (where?.createdById === "u-mine") return [{ id: "proj-mine" }];
      return [{ id: "proj-mine" }, { id: "proj-foreign" }];
    }),
  },
  repoConnection: {
    findMany: vi.fn(async ({ where }: { where: { projectId?: { in: string[] } } }) => {
      if (where.projectId?.in)
        return REPO_CONNECTIONS.filter((rc) => where.projectId!.in.includes(rc.projectId));
      return REPO_CONNECTIONS;
    }),
  },
  productDocument: {
    findMany: vi.fn(async () => [
      { id: "d1", docType: "unified-architecture", title: "Arch", content: "#", repoId: null },
    ]),
  },
  productAnalysis: {
    findMany: vi.fn(async () => [{ id: "a1", status: "completed" }]),
    // Reached only if the /:id/analyze tenant guard passes — the cross-tenant
    // regression test asserts this is never called.
    create: vi.fn(async () => ({ id: "a-new", status: "running" })),
  },
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

// Import after mocks — requirePermission, product-access, authz, project-access,
// and errorHandler all run for real.
const { productsRouter } = await import("./products-multi.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function makeUser(overrides: Partial<AuthPayload> & { role: RoleKey }): AuthPayload {
  return {
    userId: "u-mine",
    username: "mine",
    role: overrides.role,
    permissions: [],
    workspaces: ["ws-mine"],
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/products", productsRouter());
  app.use(errorHandler);
  return app;
}

describe("products-multi object-level authz (#677)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = makeUser({ role: "reader" });
    app = createApp();
    mockGetProduct.mockImplementation(async (id: string) => ({ id, name: "P", repos: [] }));
    mockListProducts.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
  });

  describe("(a) cross-tenant by-id reads → 404", () => {
    it("GET /:id on a foreign product returns 404, not the product", async () => {
      const res = await request(app).get("/products/p-foreign");
      expect(res.status).toBe(404);
      expect(mockGetProduct).not.toHaveBeenCalled();
    });

    it("GET /:id/documents on a foreign product returns 404", async () => {
      const res = await request(app).get("/products/p-foreign/documents");
      expect(res.status).toBe(404);
      expect(mockPrisma.productDocument.findMany).not.toHaveBeenCalled();
    });

    it("GET /:id/analyses on a foreign product returns 404", async () => {
      const res = await request(app).get("/products/p-foreign/analyses");
      expect(res.status).toBe(404);
      expect(mockPrisma.productAnalysis.findMany).not.toHaveBeenCalled();
    });

    it("returns 404 (not 403) so existence is not leaked", async () => {
      const res = await request(app).get("/products/p-foreign");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /:id on an unknown product returns the same 404 (no oracle)", async () => {
      const res = await request(app).get("/products/p-unknown");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(mockGetProduct).not.toHaveBeenCalled();
    });

    it("GET /:id on an unbound product (no repos/projects) is open to authed users", async () => {
      mockPrisma.product.findUnique.mockResolvedValueOnce({ projects: [], repos: [] });
      const res = await request(app).get("/products/p-unbound");
      expect(res.status).toBe(200);
      expect(mockGetProduct).toHaveBeenCalledWith("p-unbound");
    });
  });

  describe("(b) list endpoints only surface accessible rows", () => {
    it("GET /repo-connections omits foreign-project connections", async () => {
      const res = await request(app).get("/products/repo-connections");
      expect(res.status).toBe(200);
      const ids = res.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain("rc-mine");
      expect(ids).not.toContain("rc-foreign");
    });

    it("GET / filters products to the caller's accessible projects", async () => {
      await request(app).get("/products");
      expect(mockListProducts).toHaveBeenCalledTimes(1);
      const arg = mockListProducts.mock.calls[0][0] as { accessWhere?: { OR: unknown[] } };
      expect(arg.accessWhere).toBeDefined();
      const serialized = JSON.stringify(arg.accessWhere);
      expect(serialized).toContain("proj-mine");
      expect(serialized).not.toContain("proj-foreign");
    });
  });

  describe("(c) in-tenant caller succeeds", () => {
    it("GET /:id returns the product", async () => {
      const res = await request(app).get("/products/p-mine");
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("p-mine");
      expect(mockGetProduct).toHaveBeenCalledWith("p-mine");
    });

    it("GET /:id/documents returns documents", async () => {
      const res = await request(app).get("/products/p-mine/documents");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("GET /:id/analyses returns history", async () => {
      const res = await request(app).get("/products/p-mine/analyses");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe("(d) permission layer blocks a role lacking project.read", () => {
    // Every standard role (reader/developer/coordinator/admin) carries
    // project.read, so we use a permission-less role to prove the
    // requirePermission("project.read") gate is actually wired on each read.
    beforeEach(() => {
      currentUser = makeUser({ role: "nobody" as RoleKey });
    });

    it("GET / → 403", async () => {
      const res = await request(app).get("/products");
      expect(res.status).toBe(403);
      expect(mockListProducts).not.toHaveBeenCalled();
    });

    it("GET /repo-connections → 403", async () => {
      const res = await request(app).get("/products/repo-connections");
      expect(res.status).toBe(403);
      expect(mockPrisma.repoConnection.findMany).not.toHaveBeenCalled();
    });

    it("GET /:id → 403", async () => {
      const res = await request(app).get("/products/p-mine");
      expect(res.status).toBe(403);
      expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("(e) admin sees everything", () => {
    beforeEach(() => {
      currentUser = makeUser({ userId: "u-admin", role: "admin", workspaces: [] });
    });

    it("GET /:id on a foreign product succeeds (bypass)", async () => {
      const res = await request(app).get("/products/p-foreign");
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("p-foreign");
    });

    it("GET /repo-connections returns every connection", async () => {
      const res = await request(app).get("/products/repo-connections");
      expect(res.status).toBe(200);
      const ids = res.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain("rc-mine");
      expect(ids).toContain("rc-foreign");
    });

    it("GET / applies no access filter", async () => {
      await request(app).get("/products");
      const arg = mockListProducts.mock.calls[0][0] as { accessWhere?: unknown };
      expect(arg.accessWhere).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // (f) Write-side BOLA regression (#677): the PR added `assertProductAccessible`
  // to the product MUTATION routes. Assert a role-permitted-but-wrong-tenant
  // caller is stopped with 404 and the underlying service mutation never runs,
  // so a future change dropping the guard on any of these routes fails CI.
  //
  // The caller is a `coordinator` (carries `project.update`, so `requirePermission`
  // passes) whose only workspace is `ws-mine`; the target product `p-foreign` is
  // bound solely to `proj-foreign`/`ws-foreign`, so `assertProductAccessible` must
  // reject it. `project.delete` is admin-only (and admin bypasses the tenant
  // guard), so `DELETE /:id` is not reachable by any non-admin caller and cannot
  // be expressed as a cross-tenant→404 case at the HTTP layer.
  // ---------------------------------------------------------------------------
  describe("(f) cross-tenant mutations → 404, service not called", () => {
    beforeEach(() => {
      // wrong-tenant caller: has project.update but only belongs to ws-mine.
      currentUser = makeUser({ userId: "u-mine", role: "coordinator", workspaces: ["ws-mine"] });
    });

    it("PATCH /:id on a foreign product → 404, updateProduct not called", async () => {
      const res = await request(app).patch("/products/p-foreign").send({ name: "hijacked" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(mockUpdateProduct).not.toHaveBeenCalled();
    });

    it("POST /:id/repos on a foreign product → 404, addProductRepo not called", async () => {
      const res = await request(app)
        .post("/products/p-foreign/repos")
        .send({ repoConnectionId: "rc-foreign-000" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(mockAddProductRepo).not.toHaveBeenCalled();
    });

    it("DELETE /:id/repos/:repoId on a foreign product → 404, removeProductRepo not called", async () => {
      const res = await request(app).delete("/products/p-foreign/repos/rc-foreign");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(mockRemoveProductRepo).not.toHaveBeenCalled();
    });

    it("PATCH /:id/repos/:repoId on a foreign product → 404, updateProductRepo not called", async () => {
      const res = await request(app)
        .patch("/products/p-foreign/repos/rc-foreign")
        .send({ role: "primary" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(mockUpdateProductRepo).not.toHaveBeenCalled();
    });

    it("POST /:id/analyze on a foreign product → 404, no analysis record created", async () => {
      const res = await request(app).post("/products/p-foreign/analyze").send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(mockPrisma.productAnalysis.create).not.toHaveBeenCalled();
    });
  });

  // (g) The tenant guard must not over-block: an in-tenant coordinator can still
  // mutate a product bound to a project in their own workspace.
  describe("(g) in-tenant mutation succeeds (guard does not over-block)", () => {
    beforeEach(() => {
      currentUser = makeUser({ userId: "u-mine", role: "coordinator", workspaces: ["ws-mine"] });
      mockUpdateProduct.mockResolvedValue({ id: "p-mine", name: "renamed", repos: [] });
    });

    it("PATCH /:id on an in-tenant product → 200, updateProduct called", async () => {
      const res = await request(app).patch("/products/p-mine").send({ name: "renamed" });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("p-mine");
      expect(mockUpdateProduct).toHaveBeenCalledWith("p-mine", { name: "renamed" });
    });
  });
});
