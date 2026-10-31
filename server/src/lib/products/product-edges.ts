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
  type DeclareProductEdgeInput,
  type ProductEdge,
  type ProductEdgeEvidence,
  type ProductResource,
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
  const shown = edgeRows.filter(
    (e) =>
      readableRepoIds.has(e.sourceRepoId) &&
      (e.targetRepoId === null || readableRepoIds.has(e.targetRepoId)),
  );
  const shownThrough = new Set(shown.flatMap((e) => (e.resourceId ? [e.resourceId] : [])));
  const referenced = new Set(edgeRows.flatMap((e) => (e.resourceId ? [e.resourceId] : [])));
  const resources = resourceRows.filter((r) => shownThrough.has(r.id) || !referenced.has(r.id));
  return { edges: shown.map(toProductEdgeView), resources: resources.map(toProductResourceView) };
}
