/**
 * Object-level authorization for `products-multi` read/mutation endpoints —
 * Issue #677 (epic #671, OWASP A01 / BOLA).
 *
 * Products are a multi-repo aggregation. A product has NO direct `projectId`;
 * it is bound to projects via (a) its direct many-to-many `projects` relation
 * and (b) its associated repo-connections' `projectId`. The union of those is a
 * product's tenant footprint.
 *
 * One rule, two forms — the project-access rule (`assertProjectAccess`), with
 * the caller's workspaces read live from the database rather than from the
 * token's claim (#1232):
 *   - by-id reads/mutations → resolve the product's bound projects and pass any
 *     one through `canAccessProjectDiscussions` (discussions/access.ts, the
 *     function `actorHasProjectAccess` wraps): admin
 *     bypass, non-member → 404 (no existence oracle), null-workspace projects
 *     open to authed users, soft-deleted projects closed.
 *   - list endpoints → intersect rows against `listMemberAccessibleProjectIds`
 *     (the list form of the same rule). Admin sees all; a product/repo-connection
 *     bound to an inaccessible project is simply omitted (no error).
 *
 * #1232 — the list form used to be the projects the caller CREATED, so a
 * workspace teammate could open a product by id that the list never showed
 * them. Writes keep their role permission (`project.update` / `analysis.run`
 * on the routes), so a reader-role member reads only.
 *
 * A product bound to NO project (pre-migration/global) is treated as open to any
 * authenticated user, matching `assertProjectAccess`'s null-workspace convention.
 */
import type { AuthPayload } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { audit } from "../audit/audit-service.js";
import { canAccessProjectDiscussions } from "../discussions/access.js";
import {
  actorHasProjectAccess,
  isAdminActor,
  listMemberAccessibleProjectIds,
} from "../scheduler/project-access.js";
import { repoConnectionNotFound } from "./product-service.js";

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
  const actor = actorOf(user);
  for (const projectId of projectIds) {
    // No audit context per project: a product reachable through its second
    // bound project is not a probe of its first. The one denial is audited below.
    if (await canAccessProjectDiscussions(actor, projectId)) return;
  }
  audit({
    actor: { id: actor.id },
    action: "product.access.denied",
    target: { type: "product", id: productId },
    metadata: { reason: "project-access-denied", projectIds },
  });
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
  const accessibleIds = await listMemberAccessibleProjectIds(actor);
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
  const accessibleIds = await listMemberAccessibleProjectIds(actor);
  return { in: accessibleIds };
}

/**
 * #1250 — assert the caller may attach repo connection `repoConnectionId` to a
 * product: access to the PRODUCT (checked by the route) is not enough, the
 * caller must also be able to access the CONNECTION's own project, or
 * `POST /:id/analyze` would run over another workspace's repository.
 *
 * Same project-access rule as the product itself (`actorHasProjectAccess`:
 * admin bypass, live workspace members, legacy workspace-less projects open,
 * soft-deleted projects closed). A connection the caller cannot access is
 * refused exactly like one that does not exist (`REPO_NOT_FOUND`), and the
 * denial is audited as `product.repo.attach.denied`. Admins skip the read: the
 * service's own lookup answers a missing id for them.
 */
export async function assertRepoConnectionAttachable(
  user: AuthPayload,
  repoConnectionId: string,
): Promise<void> {
  const actor = actorOf(user);
  if (isAdminActor(actor)) return;
  const row = await prisma.repoConnection.findUnique({
    where: { id: repoConnectionId },
    select: { projectId: true },
  });
  if (
    row &&
    (await actorHasProjectAccess(actor, row.projectId, {
      resource: "repo_connection",
      resourceId: repoConnectionId,
      action: "product.repo.attach",
    }))
  ) {
    return;
  }
  throw repoConnectionNotFound(repoConnectionId);
}
