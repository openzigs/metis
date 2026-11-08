/**
 * Product multi-repo API client (Epic #544).
 */
import type {
  DeclareProductEdgeInput,
  DeclareProductResourceInput,
  ProductEdge,
  ProductResource,
  UpdateProductEdgeInput,
} from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

export type {
  DeclareProductEdgeInput,
  DeclareProductResourceInput,
  ProductEdge,
  ProductResource,
  UpdateProductEdgeInput,
};

export interface Product {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductRepo {
  id: string;
  productId: string;
  repoConnectionId: string;
  /** #1965 — `product_repos.role` is nullable: a repo attached without one has none. */
  role: string | null;
  createdAt: string;
  repoConnection?: {
    id: string;
    name: string;
    provider: string;
    ownerOrOrg: string;
    repoName: string;
  };
}

/**
 * #1724 — a readable repo of another product homed in the same workspace: the
 * far end a cross-product edge of this product may have.
 */
export interface LinkedRepo {
  repoConnectionId: string;
  /** `owner/name`. */
  label: string;
  productId: string;
  productName: string;
}

export interface ProductWithRepos extends Product {
  repos?: ProductRepo[];
  /**
   * #1258 — how many attached repos the caller cannot open. They are left out of
   * `repos`; only this count says they exist.
   */
  inaccessibleRepoCount?: number;
  /** #1618 — the typed edges between the repos shown, and through shared resources. */
  edges?: ProductEdge[];
  /** #1618 — the resources the product's shown repos share. */
  resources?: ProductResource[];
  /** #1724 — the other products' repos an edge of this product may end at. */
  linkedRepos?: LinkedRepo[];
}

export interface CreateProductInput {
  name: string;
  slug: string;
  description?: string;
}

export interface UpdateProductInput {
  name?: string;
  slug?: string;
  description?: string;
}

export interface AddProductRepoInput {
  repoConnectionId: string;
  role?: string;
}

export interface UpdateProductRepoInput {
  role: string;
}

export interface ProductDocument {
  id: string;
  docType: string;
  title: string;
  content: string;
  repoId: string | null;
  metadata: string;
  generatedAt: string;
  version: number;
}

/**
 * Contract-doc version + diff info decoded from an api-contract
 * `ProductDocument.metadata` blob (Issue #90 / epic #86). Used by the Contracts
 * tab to render a "diff badge".
 */
export interface ContractDocMeta {
  contractVersion: number;
  diffSummary: string;
  hasContractChanges: boolean;
}

/**
 * Parse the versioning/diff fields out of an api-contract document's
 * `metadata` JSON. Returns null when the metadata is absent, unparseable, or
 * has no contract-version field (e.g. a legacy doc, or a non-contract doc).
 */
export function parseContractDocMeta(
  doc: Pick<ProductDocument, "metadata">,
): ContractDocMeta | null {
  if (!doc.metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.contractVersion !== "number") return null;
  return {
    contractVersion: m.contractVersion,
    diffSummary: typeof m.diffSummary === "string" ? m.diffSummary : "",
    hasContractChanges: m.hasContractChanges === true,
  };
}

/**
 * #1261 — how many repos a generated document was built without, because the
 * person whose run wrote it could not open them. `0` for a complete document,
 * and for one written before the field existed.
 */
export function partialDocRepoCount(doc: Pick<ProductDocument, "metadata">): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.metadata);
  } catch {
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null) return 0;
  const m = parsed as Record<string, unknown>;
  if (m.partial !== true) return 0;
  const n = m.inaccessibleRepoCount;
  // A partial doc always lacks at least one repo, even if the count is malformed.
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 1;
}

export interface ProductAnalysis {
  id: string;
  productId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  edgeCount: number;
  error: string | null;
  triggeredBy: string | null;
  createdAt: string;
}

export interface AnalyzeResult {
  analysisId: string;
  status: string;
  documentsGenerated: number;
  edgesDetected: number;
  /** #1724 — edges to readable repos of other products in the workspace. */
  crossProductEdges?: number;
  /** #1724 — other products' repos past the per-run limit, not crawled. */
  crossProductReposSkipped?: number;
  /** #1727 — this product's repos with no clone yet (never synced), not crawled. */
  reposWithoutClone?: Array<{ repoConnectionId: string; name: string }>;
}

export interface RepoConnectionOption {
  id: string;
  label: string;
  provider: string;
  ownerOrOrg: string;
  repoName: string;
  defaultBranch: string;
  status: string;
  projectId: string;
  /** #1727 — tell same-named repos of different projects apart. */
  projectName?: string | null;
  workspaceName?: string | null;
}

export const productsApi = {
  /**
   * #1673 — `GET /products` pages by `page` and `pageSize` (`paginationQuerySchema`,
   * at most `MAX_PAGE_SIZE`); the `limit` this used to send was ignored.
   */
  list: async (params?: { search?: string; page?: number; pageSize?: number }) =>
    apiFetch<{ items: Product[]; total: number }>("/products", { params }),

  get: async (id: string) => apiFetch<ProductWithRepos>(`/products/${id}`),

  create: async (input: CreateProductInput) =>
    apiFetch<Product>("/products", { method: "POST", body: input }),

  update: async (id: string, input: UpdateProductInput) =>
    apiFetch<Product>(`/products/${id}`, { method: "PATCH", body: input }),

  delete: async (id: string) => apiFetch<void>(`/products/${id}`, { method: "DELETE" }),

  addRepo: async (productId: string, input: AddProductRepoInput) =>
    apiFetch<ProductRepo>(`/products/${productId}/repos`, { method: "POST", body: input }),

  removeRepo: async (productId: string, repoConnectionId: string) =>
    apiFetch<void>(`/products/${productId}/repos/${repoConnectionId}`, { method: "DELETE" }),

  updateRepo: async (productId: string, repoConnectionId: string, input: UpdateProductRepoInput) =>
    apiFetch<ProductRepo>(`/products/${productId}/repos/${repoConnectionId}`, {
      method: "PATCH",
      body: input,
    }),

  analyze: async (productId: string) =>
    apiFetch<AnalyzeResult>(`/products/${productId}/analyze`, { method: "POST" }),

  getDocuments: async (productId: string, docType?: string) =>
    apiFetch<ProductDocument[]>(`/products/${productId}/documents`, {
      params: docType ? { docType } : undefined,
    }),

  getAnalyses: async (productId: string) =>
    apiFetch<ProductAnalysis[]>(`/products/${productId}/analyses`),

  // #1628 — the declared-edge editor, over #1620's API. Every write is `project.update`.
  declareEdge: async (productId: string, input: DeclareProductEdgeInput) =>
    apiFetch<ProductEdge>(`/products/${encodeURIComponent(productId)}/edges`, {
      method: "POST",
      body: input,
    }),

  updateEdge: async (productId: string, edgeId: string, input: UpdateProductEdgeInput) =>
    apiFetch<ProductEdge>(
      `/products/${encodeURIComponent(productId)}/edges/${encodeURIComponent(edgeId)}`,
      { method: "PATCH", body: input },
    ),

  // #1687 — return an overridden edge to detection's classification.
  revertEdge: async (productId: string, edgeId: string) =>
    apiFetch<ProductEdge>(
      `/products/${encodeURIComponent(productId)}/edges/${encodeURIComponent(edgeId)}/revert`,
      { method: "POST" },
    ),

  deleteEdge: async (productId: string, edgeId: string) =>
    apiFetch<void>(
      `/products/${encodeURIComponent(productId)}/edges/${encodeURIComponent(edgeId)}`,
      { method: "DELETE" },
    ),

  declareResource: async (productId: string, input: DeclareProductResourceInput) =>
    apiFetch<ProductResource>(`/products/${encodeURIComponent(productId)}/resources`, {
      method: "POST",
      body: input,
    }),

  listRepoConnections: async (search?: string) =>
    apiFetch<RepoConnectionOption[]>("/products/repo-connections", {
      params: search ? { search } : undefined,
    }),
};
