/**
 * Object-level authorization for `products-multi` read/mutation endpoints —
 * Issue #677 (epic #671, OWASP A01 / BOLA).
 *
 * Products are a multi-repo aggregation. A product has NO direct `projectId`;
 * it is bound to projects via (a) its direct `projects` relation
 * (`Project.productId`) and (b) its associated repo-connections' `projectId`.
 * The union of those is a product's tenant footprint.
 *
 * #1259 / #1527 — (b) counts a repo's project only when that project is in the
 * product's HOME workspace (`Product.workspaceId`) or has no workspace (legacy,
 * open to all). The home is recorded when the first repo the product's creator
 * could have attached is attached (`addProductRepo`; the migration backfilled
 * existing products the same way) and never moves. So a `ProductRepo` row from
 * another workspace — written while the #1250 hole was open, or attached by a
 * member of two workspaces — does not open the product to that workspace, an
 * admin-created product opens to one workspace rather than every one its repos
 * sit in, and the creator leaving the workspace or losing admin does not close
 * the product to the team (#1259 read the creator's CURRENT memberships).
 *
 * One rule — the project-access rule (`assertProjectAccess`), with the
 * caller's workspaces read live from the database rather than from the token's
 * claim (#1232) — in its list form, `listMemberAccessibleProjectIds`:
 *   - by-id reads/mutations → the product's bound projects intersected with
 *     the caller's accessible set (one query, #1251; it used to judge each
 *     bound project in turn, about three queries apiece): admin bypass,
 *     non-member → 404 (no existence oracle), null-workspace projects open to
 *     authed users, soft-deleted projects closed.
 *   - list endpoints → intersect rows against the same set. Admin sees all; a
 *     product/repo-connection bound to an inaccessible project is simply
 *     omitted (no error).
 *
 * #1232 — the list form used to be the projects the caller CREATED, so a
 * workspace teammate could open a product by id that the list never showed
 * them. Writes keep their role permission (`project.update`, and
 * `project.delete` for a delete, on the routes), so a reader-role member reads
 * only.
 *
 * A product bound to NO project and carrying NO repo (pre-migration/global) is
 * treated as open to any authenticated user, matching `assertProjectAccess`'s
 * null-workspace convention. A product whose repos all fall outside the
 * footprint (#1259) is not unbound: it is closed to non-admins.
 */
import type { AuthPayload } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { audit } from "../audit/audit-service.js";
import {
  actorHasProjectAccess,
  isAdminActor,
  listMemberAccessibleProjectIds,
} from "../scheduler/project-access.js";
import { accessibleProjectWhere } from "../acp/authz.js";
import { asAuthPayload } from "../discussions/access.js";
import { repoConnectionNotFound, repoNotAssociated } from "./product-service.js";

function actorOf(user: AuthPayload): { id: string; role: AuthPayload["role"] } {
  return { id: user.userId, role: user.role };
}

/**
 * Whether an attached repo's project widens its product's footprint (#1527): it
 * has no workspace, or it is in the product's home workspace.
 */
function repoCounts(productWorkspaceId: string | null, projectWorkspaceId: string | null) {
  return projectWorkspaceId === null || projectWorkspaceId === productWorkspaceId;
}

/**
 * Resolve the project ids a product is bound to: its bound projects plus the
 * projects of its repos in its home workspace or in none (#1527). `unbound` is
 * true only when the product has no bound project AND no repo at all. Returns
 * `null` when the product does not exist.
 */
export async function resolveProductProjectIds(
  productId: string,
): Promise<{ projectIds: string[]; unbound: boolean } | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      workspaceId: true,
      projects: { select: { id: true } },
      repos: {
        select: {
          repoConnection: {
            select: { projectId: true, project: { select: { workspaceId: true } } },
          },
        },
      },
    },
  });
  if (!product) return null;
  const counted = product.repos
    .map((r) => r.repoConnection)
    .filter((rc) => repoCounts(product.workspaceId, rc.project.workspaceId));
  const ids = new Set([...product.projects.map((p) => p.id), ...counted.map((rc) => rc.projectId)]);
  return {
    projectIds: [...ids],
    unbound: product.projects.length === 0 && product.repos.length === 0,
  };
}

/**
 * Assert the caller may access `productId`. Admins bypass. A product bound to no
 * project is open to authed users. Otherwise the caller must be able to reach at
 * least one of the product's bound projects. Unknown OR out-of-tenant both →
 * `AppError(404, "NOT_FOUND")` (mirroring `assertProjectAccess`) so route probing
 * cannot distinguish the two.
 *
 * #1251 — one `listMemberAccessibleProjectIds` read and a set lookup, however
 * many projects the product is bound to.
 */
export async function assertProductAccessible(user: AuthPayload, productId: string): Promise<void> {
  if (user.role === "admin") return;
  const footprint = await resolveProductProjectIds(productId);
  if (footprint === null) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }
  // Unbound product (no repos, no project associations) → open to authed users,
  // mirroring assertProjectAccess's null-workspace convention.
  if (footprint.unbound) return;
  const { projectIds } = footprint;
  const actor = actorOf(user);
  // Bounded to the product's own projects: one query, a handful of rows.
  const accessible = new Set(await listMemberAccessibleProjectIds(actor, projectIds));
  // A product reachable through its second bound project is not a probe of its
  // first, so nothing is audited per project. The one denial is audited below.
  if (projectIds.some((projectId) => accessible.has(projectId))) return;
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
 * products bound to an accessible project, products carrying a repo of an
 * accessible project that counts towards their footprint (#1527: in the
 * product's home workspace, or in none), plus unbound products.
 *
 * #1527 — every branch is a relation filter on the project-access rule
 * (`accessibleProjectWhere`), so the statement binds the caller's workspace ids
 * and nothing that grows with the tenant: no accessible-project id list (cf.
 * #1346), no product id list. A repo is paired with its product's home by one
 * branch per workspace the caller is a live member of.
 */
export async function buildProductAccessWhere(
  user: AuthPayload,
): Promise<Prisma.ProductWhereInput | undefined> {
  const actor = actorOf(user);
  if (isAdminActor(actor)) return undefined;
  // The caller's workspaces read live, as `listMemberAccessibleProjectIds` does.
  const payload = await asAuthPayload(actor);
  const accessible = accessibleProjectWhere(payload) as Prisma.ProjectWhereInput;
  const viaRepoIn = (workspaceId: string | null): Prisma.ProductWhereInput => ({
    repos: {
      some: { repoConnection: { project: { AND: [accessible, { workspaceId }] } } },
    },
  });
  return {
    OR: [
      { projects: { some: accessible } },
      // A legacy, workspace-less repo counts on any product.
      viaRepoIn(null),
      // A workspace repo counts on a product homed in that workspace.
      ...[...new Set(payload.workspaces)].map((workspaceId) => ({
        AND: [{ workspaceId }, viaRepoIn(workspaceId)],
      })),
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
  if (await isProductRepoHiddenFrom(user, productId, repoConnectionId)) {
    throw repoNotAssociated(productId, repoConnectionId);
  }
}

/**
 * #1261 — whether `repoConnectionId` is attached to the product but its project
 * is one the caller cannot open. Always `false` for an admin, and for an id that
 * is not attached (the service answers that one).
 */
export async function isProductRepoHiddenFrom(
  user: AuthPayload,
  productId: string,
  repoConnectionId: string,
): Promise<boolean> {
  if (isAdminActor(actorOf(user))) return false;
  const link = await prisma.productRepo.findUnique({
    where: { productId_repoConnectionId: { productId, repoConnectionId } },
    select: { repoConnection: { select: { projectId: true } } },
  });
  if (!link) return false;
  const canRead = await productRepoReadAccess(user);
  return !canRead(link);
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
