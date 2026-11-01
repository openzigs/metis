/**
 * #1618 — typed product edges and shared-resource nodes.
 *
 * An edge links a source repo to a target repo, to a shared `ProductResource`
 * (a table, a topic, an identity provider), or to both, and says what crosses
 * the boundary, how tightly, in which direction, and whether detection found it
 * or a person declared it. Everything an edge references is partitioned by
 * product: its repos must be attached to the product, and its resource and
 * contract must belong to it. A reference outside the product is answered
 * exactly like a missing one, so the refusal is no existence oracle for another
 * product's rows.
 */
import {
  PRODUCT_COUPLING_STRENGTHS,
  PRODUCT_EDGE_DIRECTIONS,
  PRODUCT_EDGE_ORIGINS,
  PRODUCT_EDGE_TYPES,
  PRODUCT_INTEGRATION_KINDS,
  PRODUCT_RESOURCE_KINDS,
  DETECTED_EDGE_OVERRIDABLE_FIELDS,
  type DeclareProductEdgeInput,
  type DeclareProductResourceInput,
  type ProductEdge,
  type ProductEdgeEvidence,
  type ProductResource,
  type UpdateProductEdgeInput,
  type UpdateProductResourceInput,
} from "@metis/shared";
import type {
  ProductEdge as ProductEdgeRow,
  ProductResource as ProductResourceRow,
} from "@prisma/client";
import { prisma } from "../prisma.js";
import { isUniqueViolation } from "../db/prisma-errors.js";
import { ProductError, repoNotAssociated, type ProductActor } from "./product-service.js";

/** What an edge points at, checked against its product before it is written. */
export interface ProductEdgeReferences {
  sourceRepoId: string;
  targetRepoId?: string | null;
  resourceId?: string | null;
  contractDocId?: string | null;
}

export function resourceNotFound(resourceId: string): ProductError {
  return new ProductError(404, "RESOURCE_NOT_FOUND", `Resource ${resourceId} not found`);
}

export function contractDocNotFound(contractDocId: string): ProductError {
  return new ProductError(
    404,
    "CONTRACT_DOC_NOT_FOUND",
    `Contract document ${contractDocId} not found`,
  );
}

/**
 * Refuse an edge that does not fit its product: an edge needs a target repo or
 * a resource (not neither) and may not point back at its own source; each repo
 * must be attached to the product; the resource and the contract document must
 * be the product's own. Every lookup filters on `productId` as well as the id,
 * so product P2 cannot reference a resource of product P1 by guessing its id.
 *
 * With `readableRepoIds` (#1647) the resource and the contract must also be
 * ones the caller may see: a resource only hidden edges go through, or the
 * contract of a repo the caller cannot open, is answered as not found, exactly
 * like a missing one, so the write is no existence oracle and the GET that
 * follows does not hand back a hidden resource's name and locator.
 */
export async function assertEdgeReferencesInProduct(
  productId: string,
  refs: ProductEdgeReferences,
  readableRepoIds?: ReadonlySet<string>,
): Promise<void> {
  if (!refs.targetRepoId && !refs.resourceId) {
    throw new ProductError(
      400,
      "EDGE_TARGET_REQUIRED",
      "An edge needs a target repo, a resource, or both",
    );
  }
  if (refs.targetRepoId === refs.sourceRepoId) {
    throw new ProductError(400, "EDGE_SELF_REFERENCE", "An edge cannot go from a repo to itself");
  }
  const repoIds = [refs.sourceRepoId, ...(refs.targetRepoId ? [refs.targetRepoId] : [])];
  const attached = new Set(
    (
      await prisma.productRepo.findMany({
        where: { productId, repoConnectionId: { in: repoIds } },
        select: { repoConnectionId: true },
      })
    ).map((r) => r.repoConnectionId),
  );
  for (const id of repoIds) {
    if (!attached.has(id)) throw repoNotAssociated(productId, id);
  }
  if (refs.resourceId) {
    if (readableRepoIds) {
      await readableResourceOr404(productId, refs.resourceId, readableRepoIds);
    } else {
      const resource = await prisma.productResource.findFirst({
        where: { id: refs.resourceId, productId },
        select: { id: true },
      });
      if (!resource) throw resourceNotFound(refs.resourceId);
    }
  }
  if (refs.contractDocId) {
    const doc = await prisma.productContractDoc.findFirst({
      where: { id: refs.contractDocId, productId },
      select: { id: true, repoId: true },
    });
    const hidden = readableRepoIds && doc?.repoId && !readableRepoIds.has(doc.repoId);
    if (!doc || hidden) throw contractDocNotFound(refs.contractDocId);
  }
}

/**
 * #1647 — refuse a second edge with the same ends, type and resource as one the
 * product already has (`exceptEdgeId`: the edge being changed). Impact
 * propagation (#1623) sums severity over edges, so a duplicate would count the
 * same coupling twice; the way to change an edge is to PATCH it.
 */
async function assertNoDuplicateEdge(
  productId: string,
  key: {
    sourceRepoId: string;
    targetRepoId: string | null;
    resourceId: string | null;
    edgeType: string;
  },
  exceptEdgeId?: string,
): Promise<void> {
  const clash = await prisma.productEdge.findFirst({
    where: {
      productId,
      ...key,
      ...(exceptEdgeId ? { id: { not: exceptEdgeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw new ProductError(
      409,
      "EDGE_EXISTS",
      `This product already has that edge (${clash.id}); change it instead of declaring it again`,
    );
  }
}

/**
 * Write an edge a person declared: `origin: declared`, the declarer recorded,
 * confidence 1 (a person asserted it). The caller has already checked that the
 * actor may edit the product and read the repos it names; `readableRepoIds`
 * (#1647) limits the resource and contract it may name to ones the caller sees.
 */
export async function createDeclaredProductEdge(
  productId: string,
  input: DeclareProductEdgeInput,
  actor: ProductActor,
  readableRepoIds?: ReadonlySet<string>,
): Promise<ProductEdge> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true },
  });
  if (!product) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }
  await assertEdgeReferencesInProduct(productId, input, readableRepoIds);
  await assertNoDuplicateEdge(productId, {
    sourceRepoId: input.sourceRepoId,
    targetRepoId: input.targetRepoId ?? null,
    resourceId: input.resourceId ?? null,
    edgeType: input.edgeType,
  });
  const row = await prisma.productEdge.create({
    data: {
      productId,
      sourceRepoId: input.sourceRepoId,
      targetRepoId: input.targetRepoId ?? null,
      resourceId: input.resourceId ?? null,
      contractDocId: input.contractDocId ?? null,
      edgeType: input.edgeType,
      integrationKind: input.integrationKind,
      strength: input.strength,
      direction: input.direction,
      confidence: 1,
      origin: "declared",
      declaredById: actor.id,
    },
  });
  return toProductEdgeView(row);
}

/** `value` if it is one of `allowed`, else null (an unknown stored value reads as unclassified). */
function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function parseEvidence(raw: string): ProductEdgeEvidence[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProductEdgeEvidence[]) : [];
  } catch {
    return [];
  }
}

/** A stored edge as the API returns it: evidence parsed, enums validated. */
export function toProductEdgeView(row: ProductEdgeRow): ProductEdge {
  return {
    id: row.id,
    productId: row.productId,
    sourceRepoId: row.sourceRepoId,
    targetRepoId: row.targetRepoId,
    // Every writer (the detector, the declare route) writes one of
    // PRODUCT_EDGE_TYPES; the stored value is returned as it is.
    edgeType: row.edgeType as (typeof PRODUCT_EDGE_TYPES)[number],
    confidence: row.confidence,
    evidence: parseEvidence(row.evidence),
    sourceFile: row.sourceFile,
    targetFile: row.targetFile,
    commitSha: row.commitSha,
    integrationKind: oneOf(PRODUCT_INTEGRATION_KINDS, row.integrationKind),
    strength: oneOf(PRODUCT_COUPLING_STRENGTHS, row.strength),
    direction: oneOf(PRODUCT_EDGE_DIRECTIONS, row.direction),
    origin: oneOf(PRODUCT_EDGE_ORIGINS, row.origin) ?? "detected",
    resourceId: row.resourceId,
    contractDocId: row.contractDocId,
    declaredById: row.declaredById,
  };
}

/** Whether a stored resource kind is one `PRODUCT_RESOURCE_KINDS` still names. */
function isKnownResourceKind(kind: string): boolean {
  return oneOf(PRODUCT_RESOURCE_KINDS, kind) !== null;
}

/**
 * A stored resource as the API returns it. Its kind is returned as stored: the
 * read path (`listReadableProductGraph`) drops a row whose kind is no longer
 * known (#1647), and create and update write only a validated one.
 */
export function toProductResourceView(row: ProductResourceRow): ProductResource {
  return {
    id: row.id,
    productId: row.productId,
    kind: row.kind as (typeof PRODUCT_RESOURCE_KINDS)[number],
    name: row.name,
    locator: row.locator,
    origin: oneOf(PRODUCT_EDGE_ORIGINS, row.origin) ?? "detected",
    declaredById: row.declaredById,
  };
}

/**
 * A product's edges and resources as a caller may see them. `readableRepoIds`
 * are the product's attached, live repos the caller can open (#1258): an edge is
 * shown only when its source and (if any) its target are among them, and a
 * resource only when it has no edge at all or at least one shown edge goes
 * through it, so a resource known only from a hidden repo's code stays hidden.
 * A resource whose stored kind is not a known `PRODUCT_RESOURCE_KINDS` value is
 * not returned (#1647); an edge through it still is, by its `resourceId`.
 */
export async function listReadableProductGraph(
  productId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<{ edges: ProductEdge[]; resources: ProductResource[] }> {
  const [edgeRows, resourceRows] = await Promise.all([
    prisma.productEdge.findMany({ where: { productId }, orderBy: { createdAt: "asc" } }),
    prisma.productResource.findMany({ where: { productId }, orderBy: { createdAt: "asc" } }),
  ]);
  const shown = edgeRows.filter((e) => edgeIsReadable(e, readableRepoIds));
  const resources = resourceRows.filter(
    (r) => isKnownResourceKind(r.kind) && resourceIsReadable(r.id, edgeRows, readableRepoIds),
  );
  return { edges: shown.map(toProductEdgeView), resources: resources.map(toProductResourceView) };
}

/** An edge is readable when its source and (if any) its target repo are. */
function edgeIsReadable(
  e: { sourceRepoId: string; targetRepoId: string | null },
  readableRepoIds: ReadonlySet<string>,
): boolean {
  return (
    readableRepoIds.has(e.sourceRepoId) &&
    (e.targetRepoId === null || readableRepoIds.has(e.targetRepoId))
  );
}

/** A resource is readable when no edge goes through it, or a readable one does. */
function resourceIsReadable(
  resourceId: string,
  edges: Array<{ sourceRepoId: string; targetRepoId: string | null; resourceId: string | null }>,
  readableRepoIds: ReadonlySet<string>,
): boolean {
  const through = edges.filter((e) => e.resourceId === resourceId);
  return through.length === 0 || through.some((e) => edgeIsReadable(e, readableRepoIds));
}

// ---- Declared edges and resources (#1620) ------------------------------------

export function edgeNotFound(edgeId: string): ProductError {
  return new ProductError(404, "EDGE_NOT_FOUND", `Edge ${edgeId} not found`);
}

/**
 * The edge `edgeId` of `productId`, if the caller may see it. One that does not
 * exist, belongs to another product, or touches a repo the caller cannot read
 * is the same 404, so the answer is no existence oracle.
 */
async function readableEdgeOr404(
  productId: string,
  edgeId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<ProductEdgeRow> {
  const edge = await prisma.productEdge.findFirst({ where: { id: edgeId, productId } });
  if (!edge || !edgeIsReadable(edge, readableRepoIds)) throw edgeNotFound(edgeId);
  return edge;
}

/** The same for a resource: a resource only hidden edges go through is not found. */
async function readableResourceOr404(
  productId: string,
  resourceId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<ProductResourceRow> {
  const resource = await prisma.productResource.findFirst({ where: { id: resourceId, productId } });
  if (!resource) throw resourceNotFound(resourceId);
  const edges = await prisma.productEdge.findMany({
    where: { productId, resourceId },
    select: { sourceRepoId: true, targetRepoId: true, resourceId: true },
  });
  if (!resourceIsReadable(resourceId, edges, readableRepoIds)) throw resourceNotFound(resourceId);
  return resource;
}

/**
 * #1647 — an edge or resource detection owns: one it found (`detected`), or one
 * it found that a person then re-classified (`overridden`). Its identity (an
 * edge's ends, type and resource; a resource's kind and name) is what detection
 * matches it by, so it stays locked, and it cannot be deleted while detection
 * still finds it. Anything not `declared` is treated so, an unknown stored
 * value included: the safe reading of a row nobody can vouch for.
 */
function isDetectionOwned(origin: string): boolean {
  return origin !== "declared";
}

/**
 * Change an edge. A declared edge may change anything, re-checked against its
 * product as on create. An edge detection owns may only have its
 * classification overridden — its ends are what detection found — and becomes
 * `overridden`: re-detection (#1619) then keeps the person's classification,
 * and the edge stays as locked and as undeletable as a detected one (#1647).
 * Either way the caller is recorded as the declarer. Any repo, resource or
 * contract the result names must be readable by the caller (`readableRepoIds`),
 * or it is answered as not found (#1258, #1647).
 */
export async function updateProductEdge(
  productId: string,
  edgeId: string,
  input: UpdateProductEdgeInput,
  actor: ProductActor,
  readableRepoIds: ReadonlySet<string>,
): Promise<ProductEdge> {
  const edge = await readableEdgeOr404(productId, edgeId, readableRepoIds);
  const detectionOwned = isDetectionOwned(edge.origin);
  if (detectionOwned) {
    const locked = Object.keys(input).filter(
      (k) => !(DETECTED_EDGE_OVERRIDABLE_FIELDS as readonly string[]).includes(k),
    );
    if (locked.length > 0) {
      throw new ProductError(
        409,
        "DETECTED_EDGE_LOCKED",
        `A detected edge's ${locked.join(", ")} cannot be changed: detection would find it again. Override its integrationKind, strength or direction instead.`,
      );
    }
  }
  const next = {
    sourceRepoId: edge.sourceRepoId,
    targetRepoId: input.targetRepoId !== undefined ? input.targetRepoId : edge.targetRepoId,
    resourceId: input.resourceId !== undefined ? input.resourceId : edge.resourceId,
    contractDocId: input.contractDocId !== undefined ? input.contractDocId : edge.contractDocId,
  };
  if (next.targetRepoId && !readableRepoIds.has(next.targetRepoId)) {
    throw repoNotAssociated(productId, next.targetRepoId);
  }
  await assertEdgeReferencesInProduct(productId, next, readableRepoIds);
  const edgeType = input.edgeType ?? edge.edgeType;
  const rekeyed =
    next.targetRepoId !== edge.targetRepoId ||
    next.resourceId !== edge.resourceId ||
    edgeType !== edge.edgeType;
  if (rekeyed) {
    await assertNoDuplicateEdge(
      productId,
      {
        sourceRepoId: edge.sourceRepoId,
        targetRepoId: next.targetRepoId,
        resourceId: next.resourceId,
        edgeType,
      },
      edge.id,
    );
  }
  const row = await prisma.productEdge.update({
    where: { id: edge.id },
    data: {
      ...input,
      origin: detectionOwned ? "overridden" : "declared",
      declaredById: actor.id,
    },
  });
  return toProductEdgeView(row);
}

/**
 * Delete a declared edge. One detection owns (detected, or detected and then
 * overridden) is refused: the next detection run would find it again, so the
 * way to correct one is to override its strength.
 */
export async function deleteProductEdge(
  productId: string,
  edgeId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<void> {
  const edge = await readableEdgeOr404(productId, edgeId, readableRepoIds);
  if (isDetectionOwned(edge.origin)) {
    throw new ProductError(
      409,
      "DETECTED_EDGE_UNDELETABLE",
      "A detected edge cannot be deleted: the next detection run would find it again. Override its strength (PATCH) instead.",
    );
  }
  await prisma.productEdge.delete({ where: { id: edge.id } });
}

function resourceExists(kind: string, name: string): ProductError {
  return new ProductError(
    409,
    "RESOURCE_EXISTS",
    `This product already has a ${kind} resource named '${name}'`,
  );
}

/**
 * #1647 — `write`, with a unique violation answered as `RESOURCE_EXISTS`. The
 * pre-check that runs first answers the common case; two requests racing past
 * it meet `(productId, kind, name)`, the resource's only unique key besides its
 * id, and the loser gets the same 409 rather than a 500.
 */
async function writeResource(
  kind: string,
  name: string,
  write: () => Promise<ProductResourceRow>,
): Promise<ProductResourceRow> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err)) throw resourceExists(kind, name);
    throw err;
  }
}

/** Declare a resource on a product (`origin: declared`, the declarer recorded). */
export async function createDeclaredProductResource(
  productId: string,
  input: DeclareProductResourceInput,
  actor: ProductActor,
): Promise<ProductResource> {
  const clash = await prisma.productResource.findUnique({
    where: {
      productId_kind_name: { productId, kind: input.kind, name: input.name },
    },
    select: { id: true },
  });
  if (clash) throw resourceExists(input.kind, input.name);
  const row = await writeResource(input.kind, input.name, () =>
    prisma.productResource.create({
      data: {
        productId,
        kind: input.kind,
        name: input.name,
        locator: input.locator ?? null,
        origin: "declared",
        declaredById: actor.id,
      },
    }),
  );
  return toProductResourceView(row);
}

/**
 * Change a resource. One detection owns keeps its kind and name (detection
 * would recreate it under them) but may get a locator, which makes it
 * `overridden`: still locked and undeletable (#1647).
 */
export async function updateProductResource(
  productId: string,
  resourceId: string,
  input: UpdateProductResourceInput,
  actor: ProductActor,
  readableRepoIds: ReadonlySet<string>,
): Promise<ProductResource> {
  const resource = await readableResourceOr404(productId, resourceId, readableRepoIds);
  const detectionOwned = isDetectionOwned(resource.origin);
  const renames =
    (input.kind !== undefined && input.kind !== resource.kind) ||
    (input.name !== undefined && input.name !== resource.name);
  if (renames && detectionOwned) {
    throw new ProductError(
      409,
      "DETECTED_RESOURCE_LOCKED",
      "A detected resource cannot be renamed: detection would find it again under its old name.",
    );
  }
  const kind = input.kind ?? resource.kind;
  const name = input.name ?? resource.name;
  if (renames) {
    const clash = await prisma.productResource.findUnique({
      where: { productId_kind_name: { productId, kind, name } },
      select: { id: true },
    });
    if (clash) throw resourceExists(kind, name);
  }
  const row = await writeResource(kind, name, () =>
    prisma.productResource.update({
      where: { id: resource.id },
      data: {
        ...input,
        origin: detectionOwned ? "overridden" : "declared",
        declaredById: actor.id,
      },
    }),
  );
  return toProductResourceView(row);
}

/** What deleting a resource did to edges the caller cannot see (#1647). */
export interface ResourceDeletion {
  /** Edges through the resource that touch a repo the caller cannot read. */
  hiddenEdgeCount: number;
}

/**
 * Delete a declared resource. An edge through it that has a target repo keeps
 * that repo (its `resourceId` is set null by the foreign key); one with no
 * target repo would point at nothing, so it goes with the resource, in the
 * same transaction. A resource detection owns is refused, as such an edge is.
 *
 * The caller may see the resource (a readable edge goes through it, or none
 * does) while other edges through it touch a repo they cannot read; those
 * change too. That stays allowed, as detaching an unreadable repo is (#1261),
 * and their count is returned so the route can audit it (#1647).
 */
export async function deleteProductResource(
  productId: string,
  resourceId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<ResourceDeletion> {
  const resource = await readableResourceOr404(productId, resourceId, readableRepoIds);
  if (isDetectionOwned(resource.origin)) {
    throw new ProductError(
      409,
      "DETECTED_RESOURCE_UNDELETABLE",
      "A detected resource cannot be deleted: the next detection run would find it again.",
    );
  }
  const through = await prisma.productEdge.findMany({
    where: { productId, resourceId },
    select: { sourceRepoId: true, targetRepoId: true },
  });
  await prisma.$transaction([
    prisma.productEdge.deleteMany({
      where: { productId, resourceId, targetRepoId: null },
    }),
    prisma.productResource.delete({ where: { id: resource.id } }),
  ]);
  return {
    hiddenEdgeCount: through.filter((e) => !edgeIsReadable(e, readableRepoIds)).length,
  };
}
