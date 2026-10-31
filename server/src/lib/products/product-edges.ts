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
 * a resource (not neither); each repo must be attached to the product; the
 * resource and the contract document must be the product's own. Every lookup
 * filters on `productId` as well as the id, so product P2 cannot reference a
 * resource of product P1 by guessing its id.
 */
export async function assertEdgeReferencesInProduct(
  productId: string,
  refs: ProductEdgeReferences,
): Promise<void> {
  if (!refs.targetRepoId && !refs.resourceId) {
    throw new ProductError(
      400,
      "EDGE_TARGET_REQUIRED",
      "An edge needs a target repo, a resource, or both",
    );
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
    const resource = await prisma.productResource.findFirst({
      where: { id: refs.resourceId, productId },
      select: { id: true },
    });
    if (!resource) throw resourceNotFound(refs.resourceId);
  }
  if (refs.contractDocId) {
    const doc = await prisma.productContractDoc.findFirst({
      where: { id: refs.contractDocId, productId },
      select: { id: true },
    });
    if (!doc) throw contractDocNotFound(refs.contractDocId);
  }
}

/**
 * Write an edge a person declared: `origin: declared`, the declarer recorded,
 * confidence 1 (a person asserted it). The caller has already checked that the
 * actor may edit the product and read the repos it names.
 */
export async function createDeclaredProductEdge(
  productId: string,
  input: DeclareProductEdgeInput,
  actor: ProductActor,
): Promise<ProductEdge> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true },
  });
  if (!product) {
    throw new ProductError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }
  await assertEdgeReferencesInProduct(productId, input);
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
  const resources = resourceRows.filter((r) => resourceIsReadable(r.id, edgeRows, readableRepoIds));
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
 * Change an edge. A declared edge may change anything, re-checked against its
 * product as on create. A detected edge may only have its classification
 * overridden — its ends are what detection found — and becomes declared, so
 * re-detection (#1619) leaves the override alone. Either way the caller is
 * recorded as the declarer. Any repo the result names must be readable by the
 * caller (`readableRepoIds`), or it is answered as not attached (#1258).
 */
export async function updateProductEdge(
  productId: string,
  edgeId: string,
  input: UpdateProductEdgeInput,
  actor: ProductActor,
  readableRepoIds: ReadonlySet<string>,
): Promise<ProductEdge> {
  const edge = await readableEdgeOr404(productId, edgeId, readableRepoIds);
  if (edge.origin === "detected") {
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
  await assertEdgeReferencesInProduct(productId, next);
  const row = await prisma.productEdge.update({
    where: { id: edge.id },
    data: {
      ...input,
      origin: "declared",
      declaredById: actor.id,
    },
  });
  return toProductEdgeView(row);
}

/**
 * Delete a declared edge. A detected edge is refused: the next detection run
 * would find it again, so the way to correct one is to override its strength.
 */
export async function deleteProductEdge(
  productId: string,
  edgeId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<void> {
  const edge = await readableEdgeOr404(productId, edgeId, readableRepoIds);
  if (edge.origin === "detected") {
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

/** Declare a resource on a product (`origin: declared`, the declarer recorded). */
export async function createDeclaredProductResource(
  productId: string,
  input: DeclareProductResourceInput,
  actor: ProductActor,
): Promise<ProductResource> {
  const clash = await prisma.productResource.findUnique({
    where: { productId_kind_name: { productId, kind: input.kind, name: input.name } },
    select: { id: true },
  });
  if (clash) throw resourceExists(input.kind, input.name);
  const row = await prisma.productResource.create({
    data: {
      productId,
      kind: input.kind,
      name: input.name,
      locator: input.locator ?? null,
      origin: "declared",
      declaredById: actor.id,
    },
  });
  return toProductResourceView(row);
}

/**
 * Change a resource. A detected one keeps its kind and name (detection would
 * recreate it under them) but may get a locator, which makes it declared.
 */
export async function updateProductResource(
  productId: string,
  resourceId: string,
  input: UpdateProductResourceInput,
  actor: ProductActor,
  readableRepoIds: ReadonlySet<string>,
): Promise<ProductResource> {
  const resource = await readableResourceOr404(productId, resourceId, readableRepoIds);
  const renames =
    (input.kind !== undefined && input.kind !== resource.kind) ||
    (input.name !== undefined && input.name !== resource.name);
  if (renames && resource.origin === "detected") {
    throw new ProductError(
      409,
      "DETECTED_RESOURCE_LOCKED",
      "A detected resource cannot be renamed: detection would find it again under its old name.",
    );
  }
  if (renames) {
    const kind = input.kind ?? resource.kind;
    const name = input.name ?? resource.name;
    const clash = await prisma.productResource.findUnique({
      where: { productId_kind_name: { productId, kind, name } },
      select: { id: true },
    });
    if (clash) throw resourceExists(kind, name);
  }
  const row = await prisma.productResource.update({
    where: { id: resource.id },
    data: { ...input, origin: "declared", declaredById: actor.id },
  });
  return toProductResourceView(row);
}

/**
 * Delete a declared resource. An edge through it that has a target repo keeps
 * that repo (its `resourceId` is set null by the foreign key); one with no
 * target repo would point at nothing, so it goes with the resource, in the
 * same transaction. A detected resource is refused, as a detected edge is.
 */
export async function deleteProductResource(
  productId: string,
  resourceId: string,
  readableRepoIds: ReadonlySet<string>,
): Promise<void> {
  const resource = await readableResourceOr404(productId, resourceId, readableRepoIds);
  if (resource.origin === "detected") {
    throw new ProductError(
      409,
      "DETECTED_RESOURCE_UNDELETABLE",
      "A detected resource cannot be deleted: the next detection run would find it again.",
    );
  }
  await prisma.$transaction([
    prisma.productEdge.deleteMany({ where: { productId, resourceId, targetRepoId: null } }),
    prisma.productResource.delete({ where: { id: resource.id } }),
  ]);
}
