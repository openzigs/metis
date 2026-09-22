/**
 * Typed wrappers around the Phase 5 backend endpoints.
 *
 * `apiFetch` JSON-encodes its body, so the file-upload helper does its own
 * `fetch` call against the same Next.js proxy with FormData.
 */
import { ApiError, apiFetch } from "@/lib/api-client";
import { API_BASE } from "@/lib/config";
import type {
  AnalysisDatabaseAwareReason,
  DatabaseAwareAnalysisSetting,
  SqlLineageReason,
  SqlLineageSetting,
} from "@metis/shared";

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: "draft" | "active" | "archived";
  /** Epic #610 — owning workspace; null when the project has no workspace. */
  workspaceId?: string | null;
  /** v1.0.1 issue #134 — null/undefined ⇒ use the global default. */
  aiProviderId?: string | null;
  /** v1.2.0 — per-project AI model id override. null/undefined ⇒ use the global default. */
  aiModel?: string | null;
  /** Epic #164 — FinOps + safety project settings. */
  monthlyTokenBudget?: number | null;
  safetyMode?: "strict" | "standard" | "off";
  autopilotEnabled?: boolean;
  autopilotCostCeilingCents?: number | null;
  /** Epic #701 — opt-in to credential extraction from dev files. */
  allowCredentialScan?: boolean;
  /** Epic #852 — per-project database-aware analysis intent (`auto`/`on`/`off`). */
  databaseAwareAnalysis?: DatabaseAwareAnalysisSetting;
  /** Epic #882 — per-project SQL-lineage extraction intent (`auto`/`on`/`off`). */
  sqlLineage?: SqlLineageSetting;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListPage {
  items: Project[];
  total: number;
  limit: number;
  offset: number;
}

export interface DocumentRow {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: "pending" | "queued" | "processing" | "ready" | "failed";
  errorMessage?: string | null;
  chunkCount: number;
  /** Epic #724 — when true this document is a spec for implementation comparison. */
  isSpec?: boolean;
  uploadedAt: string;
  processedAt?: string | null;
}

export interface DocumentListPage {
  items: DocumentRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  position: number;
  text: string;
  score: number;
  embeddingModel: string;
}

export const projectsApi = {
  list: (params?: { status?: string; limit?: number; offset?: number; workspaceId?: string }) =>
    apiFetch<ProjectListPage>("/projects", { params }),
  get: (id: string) => apiFetch<Project>(`/projects/${id}`),
  create: (input: {
    name: string;
    slug: string;
    description?: string;
    workspaceId?: string;
    primaryRepo?: {
      ownerOrOrg: string;
      repoName: string;
      apiBaseUrl?: string;
      secretRef?: string;
    };
  }) => apiFetch<Project>("/projects", { method: "POST", body: input }),
  update: (
    id: string,
    input: Partial<{
      name: string;
      description: string;
      status: string;
      aiProviderId: string | null;
      aiModel: string | null;
    }>,
  ) => apiFetch<Project>(`/projects/${id}`, { method: "PATCH", body: input }),
  archive: (id: string) => apiFetch<Project>(`/projects/${id}/archive`, { method: "POST" }),
  remove: (id: string) => apiFetch<void>(`/projects/${id}`, { method: "DELETE" }),
  // Epic #164 — FinOps + safety endpoints.
  updateSafety: (id: string, body: { safetyMode: "strict" | "standard" | "off" }) =>
    apiFetch<Project>(`/projects/${id}/safety`, { method: "PATCH", body }),
  updateBudget: (id: string, body: { monthlyTokenBudget: number | null }) =>
    apiFetch<Project>(`/projects/${id}/budget`, { method: "PATCH", body }),
  updateAutopilot: (id: string, body: { enabled: boolean; costCeilingCents?: number | null }) =>
    apiFetch<Project>(`/projects/${id}/autopilot`, { method: "PATCH", body }),
  // Epic #701 — toggle credential extraction during repo scans.
  updateAllowCredentialScan: (id: string, body: { allowCredentialScan: boolean }) =>
    apiFetch<Project>(`/projects/${id}/allow-credential-scan`, { method: "PATCH", body }),
  // Epic #852 (#857) — per-project database-aware analysis intent + resolved state.
  getDatabaseAwareAnalysis: (id: string) =>
    apiFetch<DatabaseAwareAnalysisState>(`/projects/${id}/database-aware-analysis`),
  updateDatabaseAwareAnalysis: (
    id: string,
    body: { databaseAwareAnalysis: DatabaseAwareAnalysisSetting },
  ) => apiFetch<Project>(`/projects/${id}/database-aware-analysis`, { method: "PATCH", body }),
  // Epic #882 (#894) — per-project SQL-lineage intent + resolved state.
  getSqlLineage: (id: string) => apiFetch<SqlLineageState>(`/projects/${id}/sql-lineage`),
  updateSqlLineage: (id: string, body: { sqlLineage: SqlLineageSetting }) =>
    apiFetch<Project>(`/projects/${id}/sql-lineage`, { method: "PATCH", body }),
  getUsage: (id: string, params?: { from?: string; to?: string }) =>
    apiFetch<UsageSummary>(`/projects/${id}/usage-summary`, { params }),
  getSafetyEvents: (
    id: string,
    params?: { from?: string; to?: string; verdict?: string; limit?: number },
  ) => apiFetch<{ items: SafetyEventRow[] }>(`/projects/${id}/safety-events`, { params }),
  // Epic #298 / #313 — project overview.
  getOverview: (id: string) => apiFetch<ProjectOverview>(`/projects/${id}/overview`),
  regenerateOverview: (id: string) =>
    apiFetch<ProjectOverviewWithStats>(`/projects/${id}/overview/regenerate`, {
      method: "POST",
    }),
  // Epic #511 / #513 — token breakdown by category.
  getTokenBreakdown: (id: string, params?: { range?: string }) =>
    apiFetch<TokenBreakdownResponse>(`/projects/${id}/token-breakdown`, { params }),
  // Epic #594 — token budget CRUD.
  getTokenBudget: (id: string) => apiFetch<TokenBudgetResponse>(`/projects/${id}/token-budget`),
  setTokenBudget: (id: string, body: TokenBudgetInput) =>
    apiFetch<{ budget: TokenBudgetRecord }>(`/projects/${id}/token-budget`, {
      method: "PUT",
      body,
    }),
  // Epic #594 — enhanced project usage with range/groupBy.
  getEnhancedUsage: (id: string, params?: { range?: string; groupBy?: string }) =>
    apiFetch<EnhancedUsageSummary>(`/projects/${id}/usage`, { params }),
  // Epic #594 — export usage CSV.
  exportUsageCsv: (id: string, params?: { range?: string; groupBy?: string }) => {
    const qs = new URLSearchParams();
    if (params?.range) qs.set("range", params.range);
    if (params?.groupBy) qs.set("groupBy", params.groupBy);
    window.open(`/api/projects/${id}/usage/csv?${qs.toString()}`, "_blank");
  },
};

/** Epic #298 / #313 — cached project overview returned by GET /overview. */
export interface ProjectOverview {
  markdown: string;
  generatedAt: string | null;
}

/** Epic #298 / #313 — full payload returned by POST /overview/regenerate. */
export interface ProjectOverviewWithStats extends ProjectOverview {
  generatedAt: string;
  stats: {
    symbolCount: number;
    edgeCount: number;
    godNodeCount: number;
    entryPointCount: number;
    languages: Array<{ language: string; count: number }>;
  };
}

export interface UsageSummary {
  projectId: string;
  from: string;
  to: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cost of the PRICED usage only (#22). */
  costCents: number;
  /** #22 — usage from models with no configured price, reported apart. */
  unpriced: { inputTokens: number; outputTokens: number; totalTokens: number; calls: number };
  projectedMonthlyCostCents: number;
  monthlyTokenBudget: number | null;
  monthToDateTokens: number;
  byProvider: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** `null` when none of this model's usage was priced (#22). */
    costCents: number | null;
    unpricedTokens: number;
  }>;
  byDay: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number;
    unpricedTokens: number;
  }>;
}

/**
 * Epic #852 (#857) — the resolved database-aware-analysis decision for a
 * project, returned by `GET /api/projects/:id/database-aware-analysis`.
 * `hasSchemaData` drives the "no schema data yet" hint (#858): true when the
 * project has either a connected `DatabaseConnection` or a non-empty schema
 * graph, independent of whether the setting currently resolves to enabled.
 */
export interface DatabaseAwareAnalysisState {
  setting: DatabaseAwareAnalysisSetting;
  enabled: boolean;
  ran: boolean;
  reason: AnalysisDatabaseAwareReason;
  hasSchemaData: boolean;
}

/**
 * Epic #882 (#894) — the resolved SQL-lineage decision for a project,
 * returned by `GET /api/projects/:id/sql-lineage`. `sidecarConfigured` is a
 * best-effort static signal (no network probe) that the `metis-sql-lineage`
 * sidecar's shared secret is present, so the UI can show "enabled, but the
 * sidecar looks unconfigured" instead of a silent no-op.
 */
export interface SqlLineageState {
  setting: SqlLineageSetting;
  enabled: boolean;
  reason: SqlLineageReason;
  sidecarConfigured: boolean;
}

export interface SafetyEventRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  direction: "input" | "output";
  verdict: "allowed" | "blocked" | "redacted";
  findings: Array<{ kind: string; count: number; message?: string }>;
  createdAt: string;
}

/** Epic #511 / #513 — Token breakdown by category response. */
export interface TokenBreakdownCategory {
  category: string;
  tokens: number;
  percentage: number;
  trend: number | null;
}

export interface TokenBreakdownResponse {
  range: string;
  totalTokens: number;
  categories: TokenBreakdownCategory[];
  biggestCategory: string;
  suggestions: string[];
}

/** Epic #594 — Token budget types. */
export interface TokenBudgetRecord {
  id: string;
  projectId: string | null;
  userId: string | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  downgradeModel: string | null;
}

export interface BudgetStatus {
  allowed: boolean;
  remainingTokens: number;
  percentUsed: number;
  shouldDowngrade: boolean;
  message: string | null;
}

export interface TokenBudgetResponse {
  budget: TokenBudgetRecord | null;
  status: BudgetStatus;
}

export interface TokenBudgetInput {
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  downgradeModel?: string | null;
}

/** Epic #594 — Enhanced usage summary from the new aggregation API. */
export interface EnhancedUsageRow {
  dayBucket: string;
  provider: string;
  model: string;
  userId?: string;
  projectId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** `null` when none of this group's usage was priced (#22). */
  estimatedCostUsd: number | null;
  /** #22 — tokens in this group recorded without a price. */
  unpricedTokens: number;
  count: number;
}

/** #22 — usage recorded while its model had no price. */
export interface UnpricedUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  count: number;
}

export interface EnhancedUsageSummary {
  totalTokens: number;
  /** Cost of the PRICED usage only — see `unpriced`. */
  totalCostUsd: number;
  unpriced: UnpricedUsageTotals;
  rows: EnhancedUsageRow[];
}

export const documentsApi = {
  list: (projectId: string, params?: { limit?: number; offset?: number }) =>
    apiFetch<DocumentListPage>(`/projects/${projectId}/documents`, { params }),
  get: (projectId: string, documentId: string) =>
    apiFetch<DocumentRow>(`/projects/${projectId}/documents/${documentId}`),
  remove: (projectId: string, documentId: string) =>
    apiFetch<void>(`/projects/${projectId}/documents/${documentId}`, {
      method: "DELETE",
    }),
  /** Multipart upload — bypasses `apiFetch`'s JSON encoding. */
  upload: async (
    projectId: string,
    file: File,
  ): Promise<{ document: DocumentRow; ingest: { status: string; chunkCount: number } }> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_BASE}/projects/${projectId}/documents`, {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    const text = await res.text();
    let payload:
      | { success?: boolean; data?: unknown; error?: { code?: string; message?: string } }
      | undefined;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || (payload && payload.success === false)) {
      throw new ApiError(
        res.status,
        payload?.error?.message ?? res.statusText ?? "Upload failed",
        payload?.error?.code,
      );
    }
    return payload?.data as {
      document: DocumentRow;
      ingest: { status: string; chunkCount: number };
    };
  },
  /** Issue #132 — fetch a public URL on the server, then ingest it. */
  createFromUrl: (projectId: string, body: { url: string; filename?: string }) =>
    apiFetch<{
      document: DocumentRow;
      ingest: { status: string; chunkCount: number };
      source: { url: string };
    }>(`/projects/${projectId}/documents/url`, { method: "POST", body }),
  /** Issue #132 — paste raw text directly into the project. */
  createFromText: (
    projectId: string,
    body: { filename: string; content: string; mimeType?: string },
  ) =>
    apiFetch<{
      document: DocumentRow;
      ingest: { status: string; chunkCount: number };
    }>(`/projects/${projectId}/documents/text`, { method: "POST", body }),
  /** Epic #724 — toggle spec tag on a document (for spec-checking scan mode). */
  toggleSpec: (projectId: string, documentId: string, isSpec: boolean) =>
    apiFetch<DocumentRow>(`/projects/${projectId}/documents/${documentId}/spec`, {
      method: "PATCH",
      body: { isSpec },
    }),
};

export const knowledgeApi = {
  search: (projectId: string, body: { query: string; k?: number; documentIds?: string[] }) =>
    apiFetch<{ hits: RetrievedChunk[] }>(`/projects/${projectId}/retrieve`, {
      method: "POST",
      body,
    }),
};

// ── Epic #157 — RAG hardening ──────────────────────────────────────────────

export type AclSubject = { kind: "user" | "role" | "group"; value: string };

export interface QuarantineRow {
  documentId: string;
  filename: string;
  uploadedAt: string;
  chunkCount: number;
  indexState: "quarantined" | "reconciling";
  autoApproveTrusted: boolean;
  errorMessage?: string | null;
}

export interface QuarantineListResponse {
  items: QuarantineRow[];
  autoApproveTrustedSources: boolean;
}

export interface ChronicleEntry {
  id: string;
  projectId: string;
  key: string;
  value: string;
  sourceSessionId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RedTeamReport {
  total: number;
  passed: number;
  failed: number;
  score: number;
  attacks: Array<{
    attack: string;
    category: string;
    expected: string;
    observed: string;
    pass: boolean;
  }>;
  ranAt: string;
}

export const quarantineApi = {
  list: (projectId: string) =>
    apiFetch<QuarantineListResponse>(`/projects/${projectId}/quarantine`),
  approve: (projectId: string, documentId: string) =>
    apiFetch<{ document: DocumentRow; chunkCount: number }>(
      `/projects/${projectId}/documents/${documentId}/approve`,
      { method: "POST" },
    ),
  reject: (projectId: string, documentId: string, reason?: string) =>
    apiFetch<{ document: DocumentRow }>(`/projects/${projectId}/documents/${documentId}/reject`, {
      method: "POST",
      body: { reason },
    }),
  setDocAutoApprove: (projectId: string, documentId: string, autoApproveTrusted: boolean) =>
    apiFetch<DocumentRow>(`/projects/${projectId}/documents/${documentId}/auto-approve`, {
      method: "PATCH",
      body: { autoApproveTrusted },
    }),
  setProjectAutoApprove: (projectId: string, autoApproveTrustedSources: boolean) =>
    apiFetch<Project>(`/projects/${projectId}/auto-approve`, {
      method: "PATCH",
      body: { autoApproveTrustedSources },
    }),
};

export const aclApi = {
  update: (projectId: string, documentId: string, aclSubjects: AclSubject[]) =>
    apiFetch<{ chunkCount: number; aclSubjects: AclSubject[] }>(
      `/projects/${projectId}/documents/${documentId}/acl`,
      { method: "PATCH", body: { aclSubjects } },
    ),
};

export const chronicleApi = {
  list: (projectId: string) =>
    apiFetch<{ items: ChronicleEntry[]; enabled: boolean }>(`/projects/${projectId}/chronicle`),
  record: (projectId: string, body: { key: string; value: string }) =>
    apiFetch<ChronicleEntry>(`/projects/${projectId}/chronicle`, {
      method: "POST",
      body,
    }),
  forget: (projectId: string, entryId: string) =>
    apiFetch<void>(`/projects/${projectId}/chronicle/${entryId}`, {
      method: "DELETE",
    }),
  updateSettings: (
    projectId: string,
    body: { chronicleEnabled: boolean; chronicleTtlDays?: number },
  ) =>
    apiFetch<Project>(`/projects/${projectId}/chronicle/settings`, {
      method: "PATCH",
      body,
    }),
};

export const securityEvalApi = {
  run: (projectId?: string) =>
    apiFetch<RedTeamReport>("/security-eval/run", {
      method: "POST",
      body: projectId ? { projectId } : {},
    }),
};
