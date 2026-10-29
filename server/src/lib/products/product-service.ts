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
import { resolveEffectiveRoleFromRows } from "../auth/durable-roles.js";

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

/**
 * The refusal for a repo connection the caller may not attach — one that does
 * not exist, (#1258) one that is soft-deleted, or (#1250) one whose project the
 * caller cannot access. One shape
 * for both, so the answer is no existence oracle.
 */
export function repoConnectionNotFound(repoConnectionId: string): ProductError {
  return new ProductError(404, "REPO_NOT_FOUND", `RepoConnection ${repoConnectionId} not found`);
}

/**
 * The refusal for a repo that is not on the product — or (#1258) one that is, but
 * whose project the caller cannot open. One shape for both.
 */
export function repoNotAssociated(productId: string, repoId: string): ProductError {
  return new ProductError(
    404,
    "REPO_NOT_ASSOCIATED",
    `Repo ${repoId} is not associated with product ${productId}`,
  );
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * #1261 — the `ProductRepo` rows a product read returns: only those whose
 * connection is live. #1258 refuses to ATTACH a soft-deleted connection; one
 * soft-deleted after it was attached keeps its row, so every reader of a
 * product's repos (and `/analyze`) applies this filter. The row itself stays,
 * so it can still be detached by id.
 */
export const LIVE_PRODUCT_REPOS = {
  repoConnection: { deletedAt: null },
} satisfies Prisma.ProductRepoWhereInput;

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
        repos: { where: LIVE_PRODUCT_REPOS, include: { repoConnection: true } },
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
        where: LIVE_PRODUCT_REPOS,
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
    include: { repos: { where: LIVE_PRODUCT_REPOS, include: { repoConnection: true } } },
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
    include: { project: { select: { workspaceId: true } } },
  });
  // #1258 — a soft-deleted connection is refused exactly like a missing one (the
  // picker lists only live connections), for admins too.
  if (!repo || repo.deletedAt) {
    throw repoConnectionNotFound(input.repoConnectionId);
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
  const home = await homeToRecord(product, repo.project?.workspaceId ?? null);
  const link = prisma.productRepo.create({
    data: {
      productId,
      repoConnectionId: input.repoConnectionId,
      role: input.role ?? null,
    },
    include: { repoConnection: true },
  });
  if (!home) return link;
  // #1527 — the home is written with the link, and only while still unset, so a
  // concurrent attach from another workspace cannot move it.
  const [created] = await prisma.$transaction([
    link,
    prisma.product.updateMany({
      where: { id: productId, workspaceId: null },
      data: { workspaceId: home },
    }),
  ]);
  return created;
}

/**
 * #1527 — the home workspace to record for a product as a repo of `workspaceId`
 * is attached, or `null` to leave it alone. Recorded once: only while the
 * product has none, only for a repo in a workspace (a legacy repo opens the
 * product to everyone anyway), and only when the product's CREATOR could have
 * attached that repo — a system admin (the role the login path resolves), or a
 * member of its workspace. So attaching your own repo to someone else's
 * unbound product homes it nowhere (#1524 is unchanged by this).
 */
async function homeToRecord(
  product: { createdById: string; workspaceId: string | null },
  workspaceId: string | null,
): Promise<string | null> {
  if (product.workspaceId || !workspaceId) return null;
  const creator = await prisma.user.findUnique({
    where: { id: product.createdById },
    select: {
      authRoleAuthority: true,
      roles: { select: { source: true, role: { select: { key: true } } } },
      workspaceMemberships: { where: { workspaceId }, select: { id: true } },
    },
  });
  if (!creator) return null;
  const isAdmin =
    resolveEffectiveRoleFromRows(creator.roles, creator.authRoleAuthority).role === "admin";
  return isAdmin || creator.workspaceMemberships.length > 0 ? workspaceId : null;
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
    throw repoNotAssociated(productId, repoId);
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
    throw repoNotAssociated(productId, repoId);
  }
  return prisma.productRepo.update({
    where: { id: record.id },
    data: { role: input.role ?? null },
    include: { repoConnection: true },
  });
}
