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
  delete: vi.fn(),
};
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
      delete: (...args: unknown[]) => mockProduct.delete(...args),
    },
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
