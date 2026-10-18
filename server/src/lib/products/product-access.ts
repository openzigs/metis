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
import { repoConnectionNotFound, repoNotAssociated } from "./product-service.js";

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

/** A `ProductRepo` row carrying its connection's project id. */
export interface ProductRepoWithProject {
  repoConnection: { projectId: string };
}

/**
 * #1258 — whether the caller may read a product's repo: access to the PRODUCT
 * does not imply access to every repo on it. Rows attached before #1257 gated
 * the attach can name another workspace's connection, so every reader of
 * `ProductRepo` re-checks per repo, against the connection's own project.
 *
 * Same rule as {@link assertRepoConnectionAttachable}, in its list form
 * (`listMemberAccessibleProjectIds`): admins read everything, members read their
 * live workspaces' projects plus legacy workspace-less ones, soft-deleted
 * projects are closed. Build it once per request — one query however many
 * products or repos it is then applied to.
 */
export async function productRepoReadAccess(
  user: AuthPayload,
): Promise<(repo: ProductRepoWithProject) => boolean> {
  const actor = actorOf(user);
  if (isAdminActor(actor)) return () => true;
  const accessible = new Set(await listMemberAccessibleProjectIds(actor));
  return (repo) => accessible.has(repo.repoConnection.projectId);
}

/**
 * #1258 — a product as the caller may see it: only the repos `canRead` admits,
 * and `inaccessibleRepoCount` for the rest. A hidden repo contributes nothing
 * but that count — no id, name, owner or URL — so a member is told the product
 * spans more than they can see without learning what it is.
 */
export function withReadableProductRepos<P extends { repos: ProductRepoWithProject[] }>(
  product: P,
  canRead: (repo: ProductRepoWithProject) => boolean,
): P & { inaccessibleRepoCount: number } {
  const repos = product.repos.filter(canRead);
  return { ...product, repos, inaccessibleRepoCount: product.repos.length - repos.length };
}

/**
 * #1258 — refuse a per-repo operation on a repo the product carries but whose
 * project the caller cannot open, exactly as if it were not attached
 * (`REPO_NOT_ASSOCIATED`). A repo that is not on the product is left to the
 * service, which answers the same.
 */
export async function assertProductRepoReadable(
  user: AuthPayload,
  productId: string,
  repoConnectionId: string,
): Promise<void> {
  const actor = actorOf(user);
  if (isAdminActor(actor)) return;
  const link = await prisma.productRepo.findUnique({
    where: { productId_repoConnectionId: { productId, repoConnectionId } },
    select: { repoConnection: { select: { projectId: true } } },
  });
  if (!link) return;
  const canRead = await productRepoReadAccess(user);
  if (!canRead(link)) throw repoNotAssociated(productId, repoConnectionId);
}

/**
 * The repo connection ids a generated document was built from, as `/analyze`
 * records them in its metadata (#1258): every repo for the unified doc, the repo
 * and its edge neighbours for a per-service doc (it names them), the repo alone
 * for an api-contract doc. `null` for a document written before that field.
 */
function documentSourceRepoIds(doc: { metadata: string }): string[] | null {
  try {
    const meta: unknown = JSON.parse(doc.metadata);
    const ids = (meta as { repoConnectionIds?: unknown } | null)?.repoConnectionIds;
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) return ids;
  } catch {
    // Unparseable metadata records nothing — treated like a legacy document.
  }
  return null;
}

/**
 * #1258 — a product's generated documents, minus every one built from a repo the
 * caller cannot open. Documents are stored per product, not per caller, so an
 * admin's run (or one written before #1257) can hold another workspace's repo.
 * A document that does not record its sources is judged against all of the
 * product's current repos (and its own), since any of them may be named in it.
 */
export async function filterReadableProductDocuments<
  D extends { repoId: string | null; metadata: string },
>(user: AuthPayload, productId: string, docs: D[]): Promise<D[]> {
  const actor = actorOf(user);
  if (isAdminActor(actor) || docs.length === 0) return docs;
  const current = (
    await prisma.productRepo.findMany({ where: { productId }, select: { repoConnectionId: true } })
  ).map((r) => r.repoConnectionId);
  const sources = docs.map(
    (d) => documentSourceRepoIds(d) ?? (d.repoId ? [...current, d.repoId] : current),
  );
  const referenced = [...new Set(sources.flat())];
  const canRead = await productRepoReadAccess(user);
  const connections = await prisma.repoConnection.findMany({
    where: { id: { in: referenced } },
    select: { id: true, projectId: true },
  });
  const readable = new Set(
    connections.filter((c) => canRead({ repoConnection: c })).map((c) => c.id),
  );
  // A source whose connection no longer exists is not readable: nothing says whose it was.
  return docs.filter((_, i) => sources[i].every((id) => readable.has(id)));
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
