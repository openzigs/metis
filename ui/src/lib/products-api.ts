/**
 * Product multi-repo API client (Epic #544).
 */
import { apiFetch } from "@/lib/api-client";

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
  role: string;
  createdAt: string;
  repoConnection?: {
    id: string;
    name: string;
    provider: string;
    ownerOrOrg: string;
    repoName: string;
  };
}

export interface ProductWithRepos extends Product {
  repos?: ProductRepo[];
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
}

export const productsApi = {
  list: async (params?: { search?: string; limit?: number; offset?: number }) =>
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

  listRepoConnections: async (search?: string) =>
    apiFetch<RepoConnectionOption[]>("/products/repo-connections", {
      params: search ? { search } : undefined,
    }),
};
