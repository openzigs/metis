/**
 * #1724 — the repos of the other products in a product's home workspace that a
 * caller can read: the far ends a cross-product edge of this product may have.
 *
 * Detection pairs a product's repos with these (`runProductEdgeDetection`), a
 * declared edge may point at one (`assertEdgeReferencesInProduct`), and the
 * product page labels them. The rules:
 *
 * - **Same home workspace only.** A sibling is a product whose
 *   `Product.workspaceId` (#1527) equals this product's, and a sibling repo's
 *   project is in that workspace (or in none). A product with no home has no
 *   siblings, so nothing crosses a workspace boundary.
 * - **Readable only.** The repo must be one whose project the caller can open
 *   (`productRepoReadAccess`, #1258); one they cannot is not returned at all, so
 *   nothing about it (id, name, product) is disclosed. Its product needs no
 *   check of its own: a readable repo of the product's home workspace (or of no
 *   workspace) is in that product's footprint (#1527), which opens the product
 *   to the caller (`assertProductAccessible`).
 * - **Not this product's.** A repo attached to this product is its own, never a
 *   sibling, even when another product carries it as well.
 */
import type { AuthPayload } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { productRepoReadAccess, type ProductRepoWithProject } from "./product-access.js";

/**
 * A live repo connection whose project is in `workspaceId`, or in none (a legacy
 * project, open to every member). A repo of another workspace's project that a
 * sibling carries (a row of the pre-#1257 kind) does not count towards that
 * product's footprint (#1527), and is no sibling either.
 */
export function siblingRepoConnectionWhere(workspaceId: string) {
  return {
    // `LIVE_PRODUCT_REPOS`'s rule, inline: route tests mock product-service.
    deletedAt: null,
    project: { OR: [{ workspaceId }, { workspaceId: null }] },
  } satisfies Prisma.RepoConnectionWhereInput;
}

/** A readable repo of another product in the same home workspace. */
export interface SiblingRepo {
  repoConnectionId: string;
  /** The sibling product carrying it (the lowest id, if several do). */
  productId: string;
  productName: string;
  repoName: string;
  ownerOrOrg: string;
  defaultBranch: string;
  /** `owner/name`, or the connection's label when it has neither. */
  label: string;
}

/**
 * The readable repos of the other products homed in `productId`'s workspace,
 * one entry per repo, sorted by repo id. Empty when the product has no home
 * workspace or does not exist. `canRead` may be passed when the caller already
 * built it for this request.
 */
export async function listReadableSiblingRepos(
  user: AuthPayload,
  productId: string,
  canRead?: (repo: ProductRepoWithProject) => boolean,
): Promise<SiblingRepo[]> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { workspaceId: true, repos: { select: { repoConnectionId: true } } },
  });
  if (!product?.workspaceId) return [];
  const own = new Set(product.repos.map((r) => r.repoConnectionId));
  const read = canRead ?? (await productRepoReadAccess(user));
  const rows = await prisma.productRepo.findMany({
    where: {
      repoConnection: siblingRepoConnectionWhere(product.workspaceId),
      productId: { not: productId },
      product: { workspaceId: product.workspaceId },
    },
    orderBy: [{ repoConnectionId: "asc" }, { productId: "asc" }],
    select: {
      repoConnectionId: true,
      product: { select: { id: true, name: true } },
      repoConnection: {
        select: {
          projectId: true,
          label: true,
          repoName: true,
          ownerOrOrg: true,
          defaultBranch: true,
        },
      },
    },
  });
  const out = new Map<string, SiblingRepo>();
  for (const row of rows) {
    if (own.has(row.repoConnectionId) || out.has(row.repoConnectionId) || !read(row)) continue;
    const rc = row.repoConnection;
    out.set(row.repoConnectionId, {
      repoConnectionId: row.repoConnectionId,
      productId: row.product.id,
      productName: row.product.name,
      repoName: rc.repoName ?? row.repoConnectionId,
      ownerOrOrg: rc.ownerOrOrg ?? "",
      defaultBranch: rc.defaultBranch ?? "main",
      label:
        rc.ownerOrOrg && rc.repoName
          ? `${rc.ownerOrOrg}/${rc.repoName}`
          : (rc.repoName ?? rc.label),
    });
  }
  return [...out.values()];
}
