/**
 * Object-level authorization for `products-multi` read/mutation endpoints —
 * Issue #677 (epic #671, OWASP A01 / BOLA).
 *
 * Products are a multi-repo aggregation. A product has NO direct `projectId`;
 * it is bound to projects via (a) its direct many-to-many `projects` relation
 * and (b) its associated repo-connections' `projectId`. The union of those is a
 * product's tenant footprint.
 *
 * Two reuse seams, mirroring the sibling sub-issues:
 *   - by-id reads/mutations → resolve the product's bound projects and reuse
 *     `assertProjectAccess` (custom-agents/authz.ts): admin bypass, non-member →
 *     404 (no existence oracle), null-workspace projects open to authed users.
 *   - list endpoints → intersect rows against the caller's accessible project
 *     set via `listAccessibleProjectIds` (scheduler/project-access.ts). Admin
 *     sees all; a product/repo-connection bound to an inaccessible project is
 *     simply omitted (no error).
 *
 * A product bound to NO project (pre-migration/global) is treated as open to any
 * authenticated user, matching `assertProjectAccess`'s null-workspace convention.
 */
import type { AuthPayload } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { assertProjectAccess } from "../custom-agents/authz.js";
import { isAdminActor, listAccessibleProjectIds } from "../scheduler/project-access.js";

function actorOf(user: AuthPayload): { id: string; role: AuthPayload["role"] } {
  return { id: user.userId, role: user.role };
}

/**
 * Resolve the set of project ids a product is bound to (m2m projects ∪ repos'
 * repo-connection projects). Returns `null` when the product does not exist.
 */
export async function resolveProductProjectIds(productId: string): Promise<string[] | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      projects: { select: { id: true } },
      repos: { select: { repoConnection: { select: { projectId: true } } } },
    },
  });
  if (!product) return null;
  const ids = new Set<string>();
  for (const p of product.projects) ids.add(p.id);
  for (const r of product.repos) {
    if (r.repoConnection?.projectId) ids.add(r.repoConnection.projectId);
  }
  return [...ids];
}

/**
 * Assert the caller may access `productId`. Admins bypass. A product bound to no
 * project is open to authed users. Otherwise the caller must be able to reach at
 * least one of the product's bound projects. Unknown OR out-of-tenant both →
 * `AppError(404, "NOT_FOUND")` (mirroring `assertProjectAccess`) so route probing
 * cannot distinguish the two.
 */
export async function assertProductAccessible(user: AuthPayload, productId: string): Promise<void> {
  if (user.role === "admin") return;
  const projectIds = await resolveProductProjectIds(productId);
  if (projectIds === null) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }
  // Unbound product (no repos, no project associations) → open to authed users,
  // mirroring assertProjectAccess's null-workspace convention.
  if (projectIds.length === 0) return;
  for (const projectId of projectIds) {
    try {
      await assertProjectAccess(user, projectId);
      return; // reachable via at least one bound project
    } catch {
      // not reachable via this project — try the next
    }
  }
  throw new AppError(404, "NOT_FOUND", "Product not found");
}

/**
 * Prisma `where` fragment restricting a product list to the caller's accessible
 * projects. Returns `undefined` (no restriction) for admins. Non-admins see
 * products bound to an accessible project, plus unbound products.
 */
export async function buildProductAccessWhere(
  user: AuthPayload,
): Promise<Prisma.ProductWhereInput | undefined> {
  const actor = actorOf(user);
  if (isAdminActor(actor)) return undefined;
  const accessibleIds = await listAccessibleProjectIds(actor);
  return {
    OR: [
      { repos: { some: { repoConnection: { projectId: { in: accessibleIds } } } } },
      { projects: { some: { id: { in: accessibleIds } } } },
      // Unbound products (no repos AND no project associations) stay visible,
      // mirroring the by-id "open" convention above.
      { AND: [{ repos: { none: {} } }, { projects: { none: {} } }] },
    ],
  };
}

/**
 * Project-id filter for a repo-connection query. Returns `null` (no restriction)
 * for admins; otherwise an `{ in: [...] }` filter over the caller's accessible
 * project ids so `/repo-connections` only ever returns rows the caller can reach.
 */
export async function repoConnectionProjectFilter(
  user: AuthPayload,
): Promise<{ in: string[] } | null> {
  const actor = actorOf(user);
  if (isAdminActor(actor)) return null;
  const accessibleIds = await listAccessibleProjectIds(actor);
  return { in: accessibleIds };
}
