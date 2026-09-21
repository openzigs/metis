/**
 * Phase 6 — typed wrappers around `/api/mcp` for the admin UI.
 */
import { apiFetch } from "@/lib/api-client";

export type MCPStatus = "idle" | "starting" | "ready" | "error" | "disabled";
export type MCPTransport = "stdio" | "http" | "sse";
export type MCPRuntime = "native" | "docker-stdio" | "k8s-sse";
export type MCPTrustLevel = "trusted" | "untrusted";
export type MCPToolRisk = "low" | "medium" | "high";

export interface MCPToolDescriptor {
  name: string;
  description: string;
  risk: MCPToolRisk;
  inputSchema?: unknown;
}

export interface MCPServerView {
  id: string;
  scope: "global" | "project";
  projectId: string | null;
  label: string;
  transport: MCPTransport;
  /** Epic #271 — execution runtime. */
  runtime: MCPRuntime;
  command: string | null;
  args: string[] | null;
  url: string | null;
  headers: Record<string, string> | null;
  env: Record<string, string> | null;
  envSecretRefs: Record<string, string> | null;
  trustLevel: MCPTrustLevel;
  defaultToolRisk: MCPToolRisk;
  version: string | null;
  sha256: string | null;
  toolAllowlist: string[] | null;
  requireApproval: boolean;
  toolSchemaApprovedAt: string | null;
  hasApprovedSchemaSnapshot: boolean;
  status: MCPStatus;
  lastHealthCheckAt: string | null;
  latencyMs: number | null;
  failureCount: number;
  lastError: string | null;
  healthCheckIntervalSec: number;
  enabled: boolean;
  /** Epic #272 — k8s-sse runtime tunables. */
  egressAllowlist?: string | null;
  k8sMemoryLimit?: string | null;
  k8sCpuLimit?: string | null;
  coldStart?: boolean;
  capabilities: MCPToolDescriptor[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMCPServerInput {
  scope?: "global" | "project";
  projectId?: string;
  label: string;
  transport: MCPTransport;
  /** Epic #271 — execution runtime (default `native`). */
  runtime?: MCPRuntime;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  envSecretRefs?: Record<string, string>;
  trustLevel?: MCPTrustLevel;
  defaultToolRisk?: MCPToolRisk;
  healthCheckIntervalSec?: number;
  enabled?: boolean;
  /** Epic #272 — k8s-sse runtime tunables. */
  egressAllowlist?: string | null;
  k8sMemoryLimit?: string | null;
  k8sCpuLimit?: string | null;
  coldStart?: boolean;
}

export interface UpdateMCPServerInput {
  label?: string;
  /** Epic #271 — execution runtime is mutable post-registration. */
  runtime?: MCPRuntime;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  headers?: Record<string, string> | null;
  env?: Record<string, string> | null;
  envSecretRefs?: Record<string, string> | null;
  trustLevel?: MCPTrustLevel;
  defaultToolRisk?: MCPToolRisk;
  healthCheckIntervalSec?: number;
  enabled?: boolean;
  /** Epic #272 — k8s-sse runtime tunables. */
  egressAllowlist?: string | null;
  k8sMemoryLimit?: string | null;
  k8sCpuLimit?: string | null;
  coldStart?: boolean;
}

export interface MCPImportPlan {
  entries: Array<{
    label: string;
    transport: MCPTransport;
    command: string | null;
    args: string[] | null;
    url: string | null;
    headers: Record<string, string> | null;
    env: Record<string, string>;
    vaultedKeys: Record<string, string>;
  }>;
  totalSecrets: number;
}

export interface MCPImportResponse {
  plan: MCPImportPlan;
  created: Array<{ id: string; label: string }>;
  errors: Array<{ label: string; message: string }>;
  dryRun: boolean;
}

export const mcpApi = {
  list: (params?: { scope?: "global" | "project"; projectId?: string }) =>
    apiFetch<{ items: MCPServerView[] }>("/mcp", { params }),
  get: (id: string) => apiFetch<MCPServerView>(`/mcp/${id}`),
  create: (input: CreateMCPServerInput) =>
    apiFetch<MCPServerView>("/mcp", { method: "POST", body: input }),
  update: (id: string, input: UpdateMCPServerInput) =>
    apiFetch<MCPServerView>(`/mcp/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiFetch<void>(`/mcp/${id}`, { method: "DELETE" }),
  start: (id: string) => apiFetch<MCPServerView>(`/mcp/${id}/start`, { method: "POST" }),
  stop: (id: string) => apiFetch<MCPServerView>(`/mcp/${id}/stop`, { method: "POST" }),
  restart: (id: string) => apiFetch<MCPServerView>(`/mcp/${id}/restart`, { method: "POST" }),
  test: (id: string) =>
    apiFetch<{
      ok: boolean;
      latencyMs: number;
      tools: MCPToolDescriptor[];
      error?: string;
    }>(`/mcp/${id}/test`, { method: "POST" }),
  import: (input: {
    mcpJson: unknown;
    dryRun?: boolean;
    scope?: "global" | "project";
    projectId?: string | null;
    trustLevel?: MCPTrustLevel;
    labelPrefix?: string;
  }) => apiFetch<MCPImportResponse>("/mcp/import", { method: "POST", body: input }),
  getAllowList: (projectId: string) =>
    apiFetch<{ items: string[] }>(`/mcp/projects/${projectId}/allowlist`),
  setAllowList: (projectId: string, serverIds: string[]) =>
    apiFetch<{ items: string[] }>(`/mcp/projects/${projectId}/allowlist`, {
      method: "PUT",
      body: { serverIds },
    }),
  listForProject: (projectId: string) =>
    apiFetch<{ items: MCPServerView[] }>(`/mcp/projects/${projectId}/available`),
};

// ── Epic #162 — v1.1.0 platform endpoints ───────────────────────────────────

export interface MCPRegistryEntry {
  id: string;
  name: string;
  description?: string;
  version?: string;
  publisher?: string;
  category?: string;
  homepage?: string;
  repository?: string;
  install?: {
    type?: MCPTransport;
    command?: string;
    args?: string[];
    url?: string;
  };
}

export interface MCPRegistryFetchResult {
  fetchedAt: string;
  stale: boolean;
  fromCache: boolean;
  offline?: boolean;
  error?: string;
  total: number;
  servers: MCPRegistryEntry[];
}

export interface MCPSchemaDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface MCPHiddenCharRange {
  start: number;
  end: number;
  code: number;
  label: string;
}

export const mcpPlatformApi = {
  registry: (params?: { q?: string; category?: string; page?: number; pageSize?: number }) =>
    apiFetch<MCPRegistryFetchResult>("/mcp/registry", { params }),
  install: (input: {
    registryServerId: string;
    scope?: "global" | "project";
    projectId?: string | null;
    label?: string;
  }) => apiFetch<MCPServerView>("/mcp/registry/install", { method: "POST", body: input }),
  tools: (id: string) => apiFetch<{ tools: MCPToolDescriptor[] }>(`/mcp/servers/${id}/tools`),
  testTool: (id: string, tool: string, args: unknown) =>
    apiFetch<{ result: unknown; isError: boolean; durationMs: number; error?: string }>(
      `/mcp/servers/${id}/tools/${encodeURIComponent(tool)}/test`,
      { method: "POST", body: { args } },
    ),
  integrityDiff: (id: string) =>
    apiFetch<{
      diff: MCPSchemaDiff;
      approvedAt: string | null;
      hasBaseline: boolean;
      version: string | null;
      sha256: string | null;
    }>(`/mcp/servers/${id}/integrity/diff`),
  approveSnapshot: (id: string) =>
    apiFetch<MCPServerView>(`/mcp/servers/${id}/integrity/approve-snapshot`, { method: "POST" }),
  setGovernance: (
    id: string,
    input: { toolAllowlist?: string[] | null; requireApproval?: boolean },
  ) => apiFetch<MCPServerView>(`/mcp/servers/${id}/governance`, { method: "PATCH", body: input }),
  decideApproval: (approvalId: string, decision: "approved" | "denied") =>
    apiFetch<{ id: string; status: string }>(`/mcp/approvals/${approvalId}/decide`, {
      method: "POST",
      body: { decision },
    }),
  exportJson: () => apiFetch<{ servers: Record<string, unknown> }>("/mcp/export"),
  importCopilot: (input: {
    mcpJson: unknown;
    dryRun?: boolean;
    scope?: "global" | "project";
    projectId?: string | null;
  }) => apiFetch<MCPImportResponse>("/mcp/import-copilot", { method: "POST", body: input }),
  scanHiddenChars: (text: string) =>
    apiFetch<{ ranges: MCPHiddenCharRange[] }>("/mcp/scan-hidden-chars", {
      method: "POST",
      body: { text },
    }),
  // Epic #195 — federated MCP discovery (Smithery + Official mirror).
  searchFederated: (params?: {
    q?: string;
    source?: "federated" | "smithery" | "official" | "local";
    page?: number;
    pageSize?: number;
  }) => apiFetch<{ total: number; entries: McpFederationEntry[] }>("/mcp/search", { params }),
  refreshFederation: (source?: "smithery" | "official") =>
    apiFetch<{
      results: Array<{ source: string; fetched: number; upserted: number; errors: string[] }>;
    }>("/mcp/federation/refresh", { method: "POST", params: source ? { source } : undefined }),
  installFederated: (input: {
    entryId: string;
    scope?: "global" | "project";
    projectId?: string | null;
    label?: string;
  }) => apiFetch<MCPServerView>("/mcp/federation/install", { method: "POST", body: input }),
};

export interface McpFederationEntry {
  id: string;
  source: "smithery" | "official" | "local";
  externalId: string;
  name: string;
  description: string;
  publisher: string | null;
  version: string | null;
  downloads: number | null;
  stars: number | null;
  lastUpdated: string | null;
  sha256: string | null;
  manifest: Record<string, unknown>;
  metadata: Record<string, unknown>;
  fetchedAt: string;
}
