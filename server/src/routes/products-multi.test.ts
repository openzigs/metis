/**
 * Product routes unit tests (Epic #544 / Issue #546).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock product service
const mockCreateProduct = vi.fn();
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
  createProduct: (...args: unknown[]) => mockCreateProduct(...args),
  listProducts: (...args: unknown[]) => mockListProducts(...args),
  getProduct: (...args: unknown[]) => mockGetProduct(...args),
  updateProduct: (...args: unknown[]) => mockUpdateProduct(...args),
  deleteProduct: (...args: unknown[]) => mockDeleteProduct(...args),
  addProductRepo: (...args: unknown[]) => mockAddProductRepo(...args),
  removeProductRepo: (...args: unknown[]) => mockRemoveProductRepo(...args),
  updateProductRepo: (...args: unknown[]) => mockUpdateProductRepo(...args),
  ProductError: MockProductError,
}));

// Mock auth middleware. These handler-behaviour tests use an admin caller so the
// Issue #677 object-level scoping (assertProductAccessible / project filters)
// bypasses cleanly and the suite stays focused on route/handler logic. The
// object-level authz itself is covered by products-multi.authz.test.ts.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => {
    (_req as { user: { userId: string; role: string; workspaces: string[] } }).user = {
      userId: "user-1",
      role: "admin",
      workspaces: [],
    };
    next();
  },
}));

vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock prisma for the new endpoints (analyze, documents, analyses, repo-connections)
const mockPrisma = {
  product: { findUnique: vi.fn() },
  productAnalysis: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  productDocument: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  productContractDoc: { findFirst: vi.fn(), create: vi.fn() },
  repoConnection: { findMany: vi.fn() },
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

// Mock doc generators
vi.mock("../lib/products/unified-doc-generator.js", () => ({
  generateUnifiedArchitectureDoc: vi.fn(() => ({
    title: "Product — Architecture Documentation",
    content: "# Architecture",
    metadata: { generatedAt: "2026-01-01T00:00:00Z", repoCount: 1, edgeCount: 0, provenance: [] },
  })),
}));
vi.mock("../lib/products/per-service-doc-generator.js", () => ({
  generateAllPerServiceDocs: vi.fn(() => [
    {
      title: "my-repo — Service Documentation",
      content: "# Service",
      metadata: { generatedAt: "2026-01-01T00:00:00Z", repoCount: 1, edgeCount: 0, provenance: [] },
    },
  ]),
}));
// Contract-doc versioning is exercised in its own unit tests; here we stub the
// orchestrator so the analyze route test stays focused on route behaviour.
const mockRecordContractDocVersion = vi.fn(async () => ({
  version: 1,
  created: true,
  contentHash: "hash-1",
  diff: null,
  doc: {
    title: "my-repo — API Contracts",
    content: "# API\n## Changes Since Previous Version\n_Initial version._",
    metadata: { generatedAt: "2026-01-01T00:00:00Z", repoCount: 1, edgeCount: 0, provenance: [] },
  },
}));
vi.mock("../lib/products/contract-doc-versioning.js", () => ({
  recordContractDocVersion: (...args: unknown[]) => mockRecordContractDocVersion(...args),
  createPrismaContractDocStore: vi.fn(() => ({ findLatest: vi.fn(), create: vi.fn() })),
}));

// Import after mocks
const { productsRouter } = await import("./products-multi.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/products", productsRouter());
  // Error handler for tests — Express 5 requires 4-param signature
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { status?: number; code?: string; message?: string };
      res
        .status(e.status ?? 500)
        .json({ error: { code: e.code ?? "INTERNAL", message: e.message ?? "Unknown error" } });
    },
  );
  return app;
}

describe("products-multi routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe("POST /products", () => {
    it("creates a product and returns 201", async () => {
      const body = { name: "My Product", slug: "my-product", description: "Desc" };
      mockCreateProduct.mockResolvedValue({ id: "p1", ...body });

      const res = await request(app).post("/products").send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("p1");
    });

    it("returns 400 for invalid input", async () => {
      const res = await request(app).post("/products").send({ name: "" });
      expect(res.status).toBe(400);
    });

    it("returns 409 for duplicate slug", async () => {
      mockCreateProduct.mockRejectedValue(new MockProductError(409, "SLUG_TAKEN", "slug taken"));
      const res = await request(app).post("/products").send({ name: "Test", slug: "taken" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("SLUG_TAKEN");
    });
  });

  describe("GET /products", () => {
    it("lists products", async () => {
      mockListProducts.mockResolvedValue({
        items: [{ id: "p1", name: "Prod" }],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      const res = await request(app).get("/products");
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
    });

    it("supports search parameter", async () => {
      mockListProducts.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

      await request(app).get("/products?search=foo");
      expect(mockListProducts).toHaveBeenCalledWith(expect.objectContaining({ search: "foo" }));
    });

    it("supports pagination", async () => {
      mockListProducts.mockResolvedValue({ items: [], page: 2, pageSize: 5, total: 10 });

      await request(app).get("/products?page=2&pageSize=5");
      expect(mockListProducts).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 5 }),
      );
    });
  });

  describe("GET /products/:id", () => {
    it("returns product detail", async () => {
      mockGetProduct.mockResolvedValue({ id: "p1", name: "Prod", repos: [] });

      const res = await request(app).get("/products/p1");
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("p1");
    });

    it("returns 404 for unknown product", async () => {
      mockGetProduct.mockRejectedValue(new MockProductError(404, "PRODUCT_NOT_FOUND", "not found"));
      const res = await request(app).get("/products/bad");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /products/:id", () => {
    it("updates product", async () => {
      mockUpdateProduct.mockResolvedValue({ id: "p1", name: "Updated" });

      const res = await request(app).patch("/products/p1").send({ name: "Updated" });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Updated");
    });

    it("returns 404 for unknown product", async () => {
      mockUpdateProduct.mockRejectedValue(
        new MockProductError(404, "PRODUCT_NOT_FOUND", "not found"),
      );
      const res = await request(app).patch("/products/bad").send({ name: "X" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /products/:id", () => {
    it("deletes product and returns 204", async () => {
      mockDeleteProduct.mockResolvedValue(undefined);

      const res = await request(app).delete("/products/p1");
      expect(res.status).toBe(204);
    });

    it("returns 404 for unknown product", async () => {
      mockDeleteProduct.mockRejectedValue(
        new MockProductError(404, "PRODUCT_NOT_FOUND", "not found"),
      );
      const res = await request(app).delete("/products/bad");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /products/:id/repos", () => {
    it("associates a repo and returns 201", async () => {
      mockAddProductRepo.mockResolvedValue({
        id: "pr1",
        productId: "p1",
        repoConnectionId: "r1",
        role: "frontend",
      });

      const res = await request(app)
        .post("/products/p1/repos")
        .send({ repoConnectionId: "r1111111111", role: "frontend" });
      expect(res.status).toBe(201);
      expect(res.body.data.role).toBe("frontend");
    });

    it("returns 409 for duplicate association", async () => {
      mockAddProductRepo.mockRejectedValue(
        new MockProductError(409, "REPO_ALREADY_ASSOCIATED", "already associated"),
      );
      const res = await request(app)
        .post("/products/p1/repos")
        .send({ repoConnectionId: "r1111111111" });
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /products/:id/repos/:repoId", () => {
    it("removes repo and returns 204", async () => {
      mockRemoveProductRepo.mockResolvedValue(undefined);

      const res = await request(app).delete("/products/p1/repos/r1");
      expect(res.status).toBe(204);
    });

    it("returns 404 if not associated", async () => {
      mockRemoveProductRepo.mockRejectedValue(
        new MockProductError(404, "REPO_NOT_ASSOCIATED", "not associated"),
      );
      const res = await request(app).delete("/products/p1/repos/bad");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /products/:id/repos/:repoId", () => {
    it("updates repo role", async () => {
      mockUpdateProductRepo.mockResolvedValue({
        id: "pr1",
        role: "backend-api",
      });

      const res = await request(app).patch("/products/p1/repos/r1").send({ role: "backend-api" });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe("backend-api");
    });

    it("returns 404 if not associated", async () => {
      mockUpdateProductRepo.mockRejectedValue(
        new MockProductError(404, "REPO_NOT_ASSOCIATED", "not associated"),
      );
      const res = await request(app).patch("/products/p1/repos/bad").send({ role: "frontend" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /products/:id/analyze", () => {
    it("triggers analysis and returns result", async () => {
      mockPrisma.product.findUnique.mockResolvedValue({
        id: "p1",
        name: "My Product",
        description: "Desc",
        repos: [
          {
            repoConnectionId: "rc1",
            role: "backend-api",
            repoConnection: { repoName: "my-repo", ownerOrOrg: "org", defaultBranch: "main" },
          },
        ],
        edges: [],
      });
      mockPrisma.productAnalysis.create.mockResolvedValue({ id: "a1" });
      mockPrisma.productDocument.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.productDocument.create.mockResolvedValue({ id: "d1" });
      mockPrisma.productAnalysis.update.mockResolvedValue({ id: "a1", status: "completed" });

      const res = await request(app).post("/products/p1/analyze");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
      expect(res.body.data.documentsGenerated).toBeGreaterThan(0);
    });

    it("returns 404 for unknown product", async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);
      const res = await request(app).post("/products/bad/analyze");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /products/:id/documents", () => {
    it("returns documents for a product", async () => {
      mockPrisma.productDocument.findMany.mockResolvedValue([
        { id: "d1", docType: "unified-architecture", title: "Arch", content: "#", repoId: null },
      ]);
      const res = await request(app).get("/products/p1/documents");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].docType).toBe("unified-architecture");
    });

    it("filters by docType query param", async () => {
      mockPrisma.productDocument.findMany.mockResolvedValue([]);
      const res = await request(app).get("/products/p1/documents?docType=per-service");
      expect(res.status).toBe(200);
      expect(mockPrisma.productDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: "p1", docType: "per-service" } }),
      );
    });
  });

  describe("GET /products/:id/analyses", () => {
    it("returns analysis history", async () => {
      mockPrisma.productAnalysis.findMany.mockResolvedValue([
        { id: "a1", status: "completed", completedAt: "2026-01-01T00:00:00Z" },
      ]);
      const res = await request(app).get("/products/p1/analyses");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe("GET /products/repo-connections", () => {
    it("returns available repo connections", async () => {
      mockPrisma.repoConnection.findMany.mockResolvedValue([
        { id: "rc1", label: "my-repo", provider: "github", ownerOrOrg: "org", repoName: "repo" },
      ]);
      const res = await request(app).get("/products/repo-connections");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("supports search query", async () => {
      mockPrisma.repoConnection.findMany.mockResolvedValue([]);
      const res = await request(app).get("/products/repo-connections?search=my-repo");
      expect(res.status).toBe(200);
      expect(mockPrisma.repoConnection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null, OR: expect.any(Array) }),
        }),
      );
    });
  });
});
