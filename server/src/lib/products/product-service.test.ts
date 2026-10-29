/**
 * Product service unit tests (Epic #544).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
  addProductRepo,
  removeProductRepo,
  updateProductRepo,
  ProductError,
} from "./product-service.js";

// Mock prisma
const mockProduct = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
const mockUser = { findUnique: vi.fn() };
const mockTransaction = vi.fn();
const mockProductRepo = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const mockRepoConnection = {
  findUnique: vi.fn(),
};

vi.mock("../prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args: unknown[]) => mockProduct.findUnique(...args),
      findMany: (...args: unknown[]) => mockProduct.findMany(...args),
      count: (...args: unknown[]) => mockProduct.count(...args),
      create: (...args: unknown[]) => mockProduct.create(...args),
      update: (...args: unknown[]) => mockProduct.update(...args),
      updateMany: (...args: unknown[]) => mockProduct.updateMany(...args),
      delete: (...args: unknown[]) => mockProduct.delete(...args),
    },
    user: { findUnique: (...args: unknown[]) => mockUser.findUnique(...args) },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    productRepo: {
      findUnique: (...args: unknown[]) => mockProductRepo.findUnique(...args),
      create: (...args: unknown[]) => mockProductRepo.create(...args),
      update: (...args: unknown[]) => mockProductRepo.update(...args),
      delete: (...args: unknown[]) => mockProductRepo.delete(...args),
    },
    repoConnection: {
      findUnique: (...args: unknown[]) => mockRepoConnection.findUnique(...args),
    },
  },
}));

describe("product-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createProduct", () => {
    it("creates a product with valid input", async () => {
      const input = { name: "My Product", slug: "my-product", description: "Desc" };
      mockProduct.findUnique.mockResolvedValue(null);
      mockProduct.create.mockResolvedValue({ id: "p1", ...input, createdById: "u1" });

      const result = await createProduct(input, { id: "u1" });
      expect(result).toEqual({ id: "p1", ...input, createdById: "u1" });
      expect(mockProduct.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: "My Product", slug: "my-product" }),
        }),
      );
    });

    it("rejects invalid slug", async () => {
      const input = { name: "Test", slug: "INVALID SLUG!" };
      await expect(createProduct(input, { id: "u1" })).rejects.toThrow(ProductError);
      await expect(createProduct(input, { id: "u1" })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_SLUG",
      });
    });

    it("rejects duplicate slug", async () => {
      const input = { name: "Test", slug: "taken" };
      mockProduct.findUnique.mockResolvedValue({ id: "existing", slug: "taken" });
      await expect(createProduct(input, { id: "u1" })).rejects.toMatchObject({
        status: 409,
        code: "SLUG_TAKEN",
      });
    });
  });

  describe("listProducts", () => {
    it("returns paginated results", async () => {
      const items = [{ id: "p1", name: "Product 1" }];
      mockProduct.findMany.mockResolvedValue(items);
      mockProduct.count.mockResolvedValue(1);

      const result = await listProducts({ page: 1, pageSize: 10 });
      expect(result.items).toEqual(items);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it("supports search filter", async () => {
      mockProduct.findMany.mockResolvedValue([]);
      mockProduct.count.mockResolvedValue(0);

      await listProducts({ search: "foo" });
      expect(mockProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: { contains: "foo" } },
        }),
      );
    });
  });

  describe("getProduct", () => {
    it("returns product with includes", async () => {
      mockProduct.findUnique.mockResolvedValue({ id: "p1", name: "Test" });
      const result = await getProduct("p1");
      expect(result.id).toBe("p1");
    });

    it("throws 404 for non-existent product", async () => {
      mockProduct.findUnique.mockResolvedValue(null);
      await expect(getProduct("nonexistent")).rejects.toMatchObject({
        status: 404,
        code: "PRODUCT_NOT_FOUND",
      });
    });
  });

  describe("updateProduct", () => {
    it("updates product metadata", async () => {
      mockProduct.findUnique.mockResolvedValue({ id: "p1" });
      mockProduct.update.mockResolvedValue({ id: "p1", name: "Updated" });

      const result = await updateProduct("p1", { name: "Updated" });
      expect(result.name).toBe("Updated");
    });

    it("throws 404 for non-existent product", async () => {
      mockProduct.findUnique.mockResolvedValue(null);
      await expect(updateProduct("bad", { name: "x" })).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("deleteProduct", () => {
    it("deletes existing product", async () => {
      mockProduct.findUnique.mockResolvedValue({ id: "p1" });
      mockProduct.delete.mockResolvedValue({ id: "p1" });

      await deleteProduct("p1");
      expect(mockProduct.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    });

    it("throws 404 for non-existent product", async () => {
      mockProduct.findUnique.mockResolvedValue(null);
      await expect(deleteProduct("bad")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("addProductRepo", () => {
    it("associates a repo with a product", async () => {
      mockProduct.findUnique.mockResolvedValue({ id: "p1" });
      mockRepoConnection.findUnique.mockResolvedValue({ id: "r1" });
      mockProductRepo.findUnique.mockResolvedValue(null);
      mockProductRepo.create.mockResolvedValue({
        id: "pr1",
        productId: "p1",
        repoConnectionId: "r1",
        role: "frontend",
      });

      const result = await addProductRepo("p1", {
        repoConnectionId: "r1",
        role: "frontend",
      });
      expect(result.role).toBe("frontend");
    });

    it("throws 404 if product not found", async () => {
      mockProduct.findUnique.mockResolvedValue(null);
      await expect(addProductRepo("bad", { repoConnectionId: "r1" })).rejects.toMatchObject({
        status: 404,
        code: "PRODUCT_NOT_FOUND",
      });
    });

    it("throws 404 if repo not found", async () => {
      mockProduct.findUnique.mockResolvedValue({ id: "p1" });
      mockRepoConnection.findUnique.mockResolvedValue(null);
      await expect(addProductRepo("p1", { repoConnectionId: "bad" })).rejects.toMatchObject({
        status: 404,
        code: "REPO_NOT_FOUND",
      });
    });

    it("throws 409 if already associated", async () => {
      mockProduct.findUnique.mockResolvedValue({ id: "p1" });
      mockRepoConnection.findUnique.mockResolvedValue({ id: "r1" });
      mockProductRepo.findUnique.mockResolvedValue({ id: "existing" });
      await expect(addProductRepo("p1", { repoConnectionId: "r1" })).rejects.toMatchObject({
        status: 409,
        code: "REPO_ALREADY_ASSOCIATED",
      });
    });
  });

  describe("addProductRepo records the product's home workspace (#1527)", () => {
    const LINK = { id: "pr1", productId: "p1", repoConnectionId: "r1" };
    const UPDATE = { kind: "home-update" };
    const creator = (opts: { admin?: boolean; member?: boolean }) => ({
      authRoleAuthority: "unknown",
      roles: [{ source: "local", role: { key: opts.admin ? "admin" : "coordinator" } }],
      workspaceMemberships: opts.member ? [{ id: "m1" }] : [],
    });
    const attach = async (opts: {
      productHome?: string | null;
      repoWorkspace?: string | null;
      creator?: ReturnType<typeof creator> | null;
    }) => {
      mockProduct.findUnique.mockResolvedValue({
        id: "p1",
        createdById: "u1",
        workspaceId: opts.productHome ?? null,
      });
      mockRepoConnection.findUnique.mockResolvedValue({
        id: "r1",
        deletedAt: null,
        project: { workspaceId: opts.repoWorkspace === undefined ? "ws1" : opts.repoWorkspace },
      });
      mockProductRepo.findUnique.mockResolvedValue(null);
      mockProductRepo.create.mockReturnValue(LINK);
      mockProduct.updateMany.mockReturnValue(UPDATE);
      mockUser.findUnique.mockResolvedValue(opts.creator === undefined ? null : opts.creator);
      mockTransaction.mockImplementation(async (ops: unknown[]) => ops);
      return addProductRepo("p1", { repoConnectionId: "r1" });
    };

    it("writes the repo's workspace with the link when the creator is a member of it", async () => {
      expect(await attach({ creator: creator({ member: true }) })).toBe(LINK);
      expect(mockUser.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "u1" },
          select: expect.objectContaining({
            workspaceMemberships: { where: { workspaceId: "ws1" }, select: { id: true } },
          }),
        }),
      );
      // Only while still unset, in one transaction with the link.
      expect(mockProduct.updateMany).toHaveBeenCalledWith({
        where: { id: "p1", workspaceId: null },
        data: { workspaceId: "ws1" },
      });
      expect(mockTransaction).toHaveBeenCalledWith([LINK, UPDATE]);
    });

    it("writes it when the creator is a system admin in no workspace", async () => {
      await attach({ creator: creator({ admin: true }) });
      expect(mockTransaction).toHaveBeenCalledWith([LINK, UPDATE]);
    });

    it("leaves it alone when the creator could not have attached the repo", async () => {
      expect(await attach({ creator: creator({}) })).toBe(LINK);
      expect(mockProduct.updateMany).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("leaves it alone when the creator row is gone", async () => {
      await attach({ creator: null });
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("never moves a recorded home, and a legacy repo records none (no creator read)", async () => {
      await attach({ productHome: "ws0", creator: creator({ admin: true }) });
      await attach({ repoWorkspace: null, creator: creator({ admin: true }) });
      expect(mockUser.findUnique).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe("removeProductRepo", () => {
    it("removes repo from product", async () => {
      mockProductRepo.findUnique.mockResolvedValue({ id: "pr1" });
      mockProductRepo.delete.mockResolvedValue({ id: "pr1" });

      await removeProductRepo("p1", "r1");
      expect(mockProductRepo.delete).toHaveBeenCalledWith({ where: { id: "pr1" } });
    });

    it("throws 404 if not associated", async () => {
      mockProductRepo.findUnique.mockResolvedValue(null);
      await expect(removeProductRepo("p1", "r1")).rejects.toMatchObject({
        status: 404,
        code: "REPO_NOT_ASSOCIATED",
      });
    });
  });

  describe("updateProductRepo", () => {
    it("updates repo role", async () => {
      mockProductRepo.findUnique.mockResolvedValue({ id: "pr1" });
      mockProductRepo.update.mockResolvedValue({ id: "pr1", role: "backend-api" });

      const result = await updateProductRepo("p1", "r1", { role: "backend-api" });
      expect(result.role).toBe("backend-api");
    });

    it("throws 404 if not associated", async () => {
      mockProductRepo.findUnique.mockResolvedValue(null);
      await expect(updateProductRepo("p1", "r1", { role: "frontend" })).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
