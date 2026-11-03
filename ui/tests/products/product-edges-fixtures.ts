/**
 * #1628 — a product with two repos, one shared resource and a detected and a
 * declared edge, as `GET /api/products/:id` returns it.
 */
import type { ProductEdge, ProductResource, ProductWithRepos } from "@/lib/products-api";

export const PRODUCT_ID = "prod-0000000001";
export const REPO_A = "rc-a000000001";
export const REPO_B = "rc-b000000001";
/** #1724 — a repo of another product in the workspace. */
export const REPO_FAR = "rc-f000000001";
export const linkedRepo = {
  repoConnectionId: REPO_FAR,
  label: "acme/billing",
  productId: "prod-0000000002",
  productName: "Billing",
};

export function repo(id: string, name: string) {
  return {
    id: `pr-${id}`,
    productId: PRODUCT_ID,
    repoConnectionId: id,
    role: "backend-api",
    createdAt: "2026-11-01T00:00:00.000Z",
    repoConnection: { id, name, provider: "github", ownerOrOrg: "acme", repoName: name },
  };
}

export const idp: ProductResource = {
  id: "res-idp000001",
  productId: PRODUCT_ID,
  kind: "identity-provider",
  name: "Okta",
  locator: "https://acme.okta.com",
  origin: "declared",
  declaredById: "u-1",
};

export function edge(over: Partial<ProductEdge> = {}): ProductEdge {
  return {
    id: "edge-detected1",
    productId: PRODUCT_ID,
    sourceRepoId: REPO_A,
    targetRepoId: REPO_B,
    edgeType: "calls",
    confidence: 0.72,
    evidence: [],
    integrationKind: "api",
    strength: "contract",
    direction: "consumes",
    origin: "detected",
    resourceId: null,
    contractDocId: null,
    declaredById: null,
    ...over,
  };
}

export const detectedEdge = edge();

export const declaredEdge = edge({
  id: "edge-declared1",
  sourceRepoId: REPO_B,
  targetRepoId: null,
  resourceId: idp.id,
  edgeType: "consumes",
  confidence: 1,
  integrationKind: "identity",
  strength: "functional",
  direction: "depends-on",
  origin: "declared",
  declaredById: "u-1",
});

export function product(over: Partial<ProductWithRepos> = {}): ProductWithRepos {
  return {
    id: PRODUCT_ID,
    name: "Payments",
    slug: "payments",
    description: "",
    createdById: "u-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    repos: [repo(REPO_A, "checkout"), repo(REPO_B, "ledger")],
    edges: [detectedEdge, declaredEdge],
    resources: [idp],
    ...over,
  };
}
