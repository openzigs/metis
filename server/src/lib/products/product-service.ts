/**
 * Product service — CRUD operations for multi-repo products (Epic #544).
 */
import type {
  CreateProductInput,
  UpdateProductInput,
  AddProductRepoInput,
  UpdateProductRepoInput,
} from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

export class ProductError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProductError";
    this.status = status;
    this.code = code;
  }
}

export interface ProductActor {
  id: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function createProduct(input: CreateProductInput, actor: ProductActor) {
  const slug = input.slug.toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProductError(400, "INVALID_SLUG", "slug must be lowercase alphanumeric/hyphen");
  }
  const existing = await prisma.product.findUnique({ where: { slug } });
  if (existing) {
    throw new ProductError(409, "SLUG_TAKEN", `slug '${slug}' already exists`);
  }
  return prisma.product.create({
    data: {
      name: input.name,
      slug,
      description: input.description ?? "",
      createdById: actor.id,
    },
    include: { repos: { include: { repoConnection: true } } },
  });
}

export async function listProducts(opts: {
  page?: number;
  pageSize?: number;
  search?: string;
  /**
   * Issue #677 — object-level scoping. When provided, restricts the listing to
   * products the caller can access (ANDed with any search filter). Omitted for
   * admins (no restriction).
   */
  accessWhere?: Prisma.ProductWhereInput;
}) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 20;
  const searchWhere: Prisma.ProductWhereInput = opts.search
    ? { name: { contains: opts.search } }
    : {};
  const where: Prisma.ProductWhereInput = opts.accessWhere
    ? { AND: [searchWhere, opts.accessWhere] }
    : searchWhere;
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        repos: { include: { repoConnection: true } },
        _count: { select: { edges: true, analyses: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return { items, page, pageSize, total };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      repos: {
        include: {
          repoConnection: {
            select: {
              id: true,
              label: true,
              provider: true,
              ownerOrOrg: true,
              repoName: true,
              defaultBranch: true,
              status: true,
              projectId: true,
            },
          },
        },
      },
      _count: { select: { edges: true, analyses: true, documents: true } },
    },
  });
  if (!product) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${id} not found`);
  }
  return product;
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${id} not found`);
  }
  return prisma.product.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
    },
    include: { repos: { include: { repoConnection: true } } },
  });
}

export async function deleteProduct(id: string) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${id} not found`);
  }
  await prisma.product.delete({ where: { id } });
}

export async function addProductRepo(productId: string, input: AddProductRepoInput) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }
  const repo = await prisma.repoConnection.findUnique({
    where: { id: input.repoConnectionId },
  });
  if (!repo) {
    throw new ProductError(
      404,
      "REPO_NOT_FOUND",
      `RepoConnection ${input.repoConnectionId} not found`,
    );
  }
  const existing = await prisma.productRepo.findUnique({
    where: {
      productId_repoConnectionId: {
        productId,
        repoConnectionId: input.repoConnectionId,
      },
    },
  });
  if (existing) {
    throw new ProductError(
      409,
      "REPO_ALREADY_ASSOCIATED",
      `Repo ${input.repoConnectionId} is already associated with this product`,
    );
  }
  return prisma.productRepo.create({
    data: {
      productId,
      repoConnectionId: input.repoConnectionId,
      role: input.role ?? null,
    },
    include: { repoConnection: true },
  });
}

export async function removeProductRepo(productId: string, repoId: string) {
  const record = await prisma.productRepo.findUnique({
    where: {
      productId_repoConnectionId: {
        productId,
        repoConnectionId: repoId,
      },
    },
  });
  if (!record) {
    throw new ProductError(
      404,
      "REPO_NOT_ASSOCIATED",
      `Repo ${repoId} is not associated with product ${productId}`,
    );
  }
  await prisma.productRepo.delete({ where: { id: record.id } });
}

export async function updateProductRepo(
  productId: string,
  repoId: string,
  input: UpdateProductRepoInput,
) {
  const record = await prisma.productRepo.findUnique({
    where: {
      productId_repoConnectionId: {
        productId,
        repoConnectionId: repoId,
      },
    },
  });
  if (!record) {
    throw new ProductError(
      404,
      "REPO_NOT_ASSOCIATED",
      `Repo ${repoId} is not associated with product ${productId}`,
    );
  }
  return prisma.productRepo.update({
    where: { id: record.id },
    data: { role: input.role ?? null },
    include: { repoConnection: true },
  });
}
