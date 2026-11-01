/**
 * #1628 — the pure half of the product page's declared-edge editor: the kind
 * filter, the form draft and the request body it becomes, and the labels the
 * edge list shows. The component (`components/products/product-edges-panel`)
 * holds only state and requests.
 */
import {
  PRODUCT_COUPLING_STRENGTHS,
  PRODUCT_EDGE_DIRECTIONS,
  PRODUCT_EDGE_TYPES,
  PRODUCT_INTEGRATION_KINDS,
  type ProductCouplingStrength,
  type ProductEdgeDirection,
  type ProductEdgeType,
  type ProductIntegrationKind,
} from "@metis/shared";
import type {
  DeclareProductEdgeInput,
  ProductEdge,
  ProductResource,
  ProductWithRepos,
  UpdateProductEdgeInput,
} from "@/lib/products-api";

export {
  PRODUCT_COUPLING_STRENGTHS,
  PRODUCT_EDGE_DIRECTIONS,
  PRODUCT_EDGE_TYPES,
  PRODUCT_INTEGRATION_KINDS,
};

/** The kind filter: every edge, or only those of one integration kind. */
export type EdgeKindFilter = "all" | ProductIntegrationKind;

/**
 * The edges the filter keeps. An edge written before the coupling model has no
 * kind (`null`), so only "all" shows it.
 */
export function filterEdgesByKind(edges: ProductEdge[], filter: EdgeKindFilter): ProductEdge[] {
  return filter === "all" ? edges : edges.filter((e) => e.integrationKind === filter);
}

/**
 * Only a declared edge may be deleted or re-pointed. One detection owns
 * (`detected`, or `overridden` after a person re-classified it) would be found
 * again by the next run, so the server refuses to delete it (#1620, #1647) and
 * the editor offers a strength override instead. Anything not `declared` is
 * treated as detection-owned, as the server does.
 */
export function isDeclaredEdge(edge: Pick<ProductEdge, "origin">): boolean {
  return edge.origin === "declared";
}

/** The edge editor's form state. An empty string is "none". */
export interface EdgeDraft {
  sourceRepoId: string;
  targetRepoId: string;
  resourceId: string;
  edgeType: ProductEdgeType;
  integrationKind: ProductIntegrationKind;
  strength: ProductCouplingStrength;
  direction: ProductEdgeDirection;
}

/** A blank draft starting at the product's first repo. */
export function emptyEdgeDraft(firstRepoId = ""): EdgeDraft {
  return {
    sourceRepoId: firstRepoId,
    targetRepoId: "",
    resourceId: "",
    edgeType: "calls",
    integrationKind: "api",
    strength: "contract",
    direction: "consumes",
  };
}

/**
 * The draft for editing `edge`. An edge written before the coupling model has
 * no classification; the form starts it at the blank draft's defaults.
 */
export function draftFromEdge(edge: ProductEdge): EdgeDraft {
  const blank = emptyEdgeDraft(edge.sourceRepoId);
  return {
    sourceRepoId: edge.sourceRepoId,
    targetRepoId: edge.targetRepoId ?? "",
    resourceId: edge.resourceId ?? "",
    edgeType: edge.edgeType,
    integrationKind: edge.integrationKind ?? blank.integrationKind,
    strength: edge.strength ?? blank.strength,
    direction: edge.direction ?? blank.direction,
  };
}

/**
 * Why the draft cannot be saved, or null. The same two rules the server
 * enforces (#1618): an edge goes to a target repo, through a resource, or both,
 * and never from a repo to itself. Checked here so the person is told before a
 * round trip; the server still decides.
 */
export function edgeDraftError(draft: EdgeDraft): string | null {
  if (!draft.sourceRepoId) return "Choose the repository the edge starts from.";
  if (!draft.targetRepoId && !draft.resourceId) {
    return "Choose a target repository, a shared resource, or both.";
  }
  if (draft.targetRepoId === draft.sourceRepoId) {
    return "An edge cannot go from a repository to itself.";
  }
  return null;
}

/** The `POST /api/products/:id/edges` body for a new declared edge. */
export function declareEdgeBody(draft: EdgeDraft): DeclareProductEdgeInput {
  return {
    sourceRepoId: draft.sourceRepoId,
    targetRepoId: draft.targetRepoId || null,
    resourceId: draft.resourceId || null,
    edgeType: draft.edgeType,
    integrationKind: draft.integrationKind,
    strength: draft.strength,
    direction: draft.direction,
  };
}

/**
 * The `PATCH` body for an edited declared edge. The source repo is not in it:
 * the API does not let an edge change where it starts. The contract document is
 * not either, so an edit leaves it as it was.
 */
export function updateEdgeBody(draft: EdgeDraft): UpdateProductEdgeInput {
  return {
    targetRepoId: draft.targetRepoId || null,
    resourceId: draft.resourceId || null,
    edgeType: draft.edgeType,
    integrationKind: draft.integrationKind,
    strength: draft.strength,
    direction: draft.direction,
  };
}

/** `owner/name` for a repo the product shows; the bare id when it has no connection row. */
export function repoLabel(product: Pick<ProductWithRepos, "repos">, repoConnectionId: string) {
  const repo = product.repos?.find((r) => r.repoConnectionId === repoConnectionId);
  return repo?.repoConnection
    ? `${repo.repoConnection.ownerOrOrg}/${repo.repoConnection.repoName}`
    : repoConnectionId;
}

/** A resource's name and kind, as the "to" side of an edge through it. */
export function resourceLabel(resources: ProductResource[], resourceId: string): string {
  const resource = resources.find((r) => r.id === resourceId);
  return resource ? `${resource.name} (${resource.kind})` : resourceId;
}

/** What the edge's far end is: a repo, a resource, or a repo through a resource. */
export function edgeTargetLabel(
  product: Pick<ProductWithRepos, "repos">,
  resources: ProductResource[],
  edge: Pick<ProductEdge, "targetRepoId" | "resourceId">,
): string {
  const repo = edge.targetRepoId ? repoLabel(product, edge.targetRepoId) : null;
  const via = edge.resourceId ? resourceLabel(resources, edge.resourceId) : null;
  if (repo && via) return `${repo} via ${via}`;
  return repo ?? via ?? "";
}

/** Confidence as a whole percentage: a declared edge is 100%. */
export function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

const ORIGIN_LABELS: Record<string, string> = {
  detected: "Detected",
  declared: "Declared",
  overridden: "Detected (overridden)",
};

/** The origin as shown; an unknown stored value is shown as it is. */
export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}
