/**
 * Typed wrappers around the `/api/projects/:projectId/test-coverage/*`
 * REST surface (Epic #856 Phase 4 — issue #865).
 *
 * The export endpoint streams binary content (Excel `.xlsx`, Gherkin
 * `.feature` / `.zip`) so it bypasses `apiFetch` (which JSON-parses the
 * response) and uses `fetch` directly against the Next.js proxy. The
 * proxy forwards cookies and binary bodies verbatim.
 */
import { apiFetch } from "@/lib/api-client";
import { API_BASE } from "@/lib/config";

export interface TestImportSummary {
  id: string;
  source: string;
  filename: string | null;
  byteSize: number | null;
  createdById: string | null;
  createdAt: string;
  casesParsed: number;
  casesUpserted: number;
}

export interface TestCoverageRun {
  id: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  triggeredById: string | null;
  modelTag: string | null;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface CoverageMappingDto {
  id: string;
  runId: string;
  requirementId: string;
  testCaseDocId: string;
  cosine: number;
  bm25: number;
  fused: number;
  judgeConfidence: number | null;
  status: string;
  overriddenById: string | null;
  overrideReason: string | null;
}

export interface GapItemDto {
  id: string;
  runId: string;
  requirementId: string;
  severity: "low" | "medium" | "high" | "critical" | string;
  meta: string;
}

export interface SuggestionDto {
  id: string;
  runId: string;
  title: string;
  mappedRequirementIds: string;
  gwtJson: string;
  stepsJson: string;
  faithfulness: number;
  lowConfidence: boolean;
  status: "draft" | "accepted" | "rejected" | "exported" | string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Aggregate coverage numbers for a run. Emitted by the server under
 * `summary` — see `GET /runs/:runId/report` in
 * `server/src/routes/test-coverage.ts`. The percentage field is
 * `coveragePct` (0–100); reading `report.coveragePercentage` was the cause
 * of the page-crash bug (it was always `undefined` → `.toFixed` threw).
 */
export interface RunReportSummary {
  total: number;
  covered: number;
  gaps: number;
  suggestions: number;
  coveragePct: number;
}

export interface RunReport {
  run: TestCoverageRun;
  summary: RunReportSummary;
  mappings: CoverageMappingDto[];
  gaps: GapItemDto[];
  suggestions: SuggestionDto[];
}

export interface RunBudgetState {
  /**
   * Cents spent so far on this run. The server emits this as `usedCents` —
   * keep the name aligned with `CoverageBudgetView` in
   * `server/src/lib/testcoverage/cost-tracker.ts` or the budget block
   * renders `$NaN` / `NaN%` at runtime.
   */
  usedCents: number;
  limitCents: number;
  remainingCents: number;
  breakdown?: {
    embeddingTokens: number;
    judgeTokens: number;
    suggestionTokens: number;
  };
}

export type ExportTarget = "excel" | "gherkin" | "github" | "xray" | "zephyr" | "testrail" | "jira";

export type ConnectorSource = "jira" | "xray" | "zephyr" | "testrail";

export interface JiraConnectorConfig {
  edition: "cloud" | "server";
  baseUrl: string;
  username: string;
  apiToken: string;
  projectKey: string;
}

export interface XrayConnectorConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectKey: string;
}

export interface ZephyrConnectorConfig {
  baseUrl: string;
  bearerToken: string;
  projectKey: string;
}

export interface TestRailConnectorConfig {
  baseUrl: string;
  email: string;
  apiKey: string;
  projectId: number;
  suiteId?: number;
}

/**
 * Connector pulls support two modes:
 *   - inline credentials (legacy, jira-only and the existing per-request flow)
 *   - `connectionId` referencing a saved `TestManagementConnection` (xray /
 *     zephyr / testrail). When `connectionId` is provided the per-pull options
 *     (projectKey, projectId, suiteId, folderId, pageSize) are still required
 *     but credentials/baseUrl are resolved server-side from the vault.
 */
export interface SavedConnectionXrayPull {
  source: "xray";
  label?: string;
  connectionId: string;
  projectKey: string;
  pageSize?: number;
}

export interface SavedConnectionZephyrPull {
  source: "zephyr";
  label?: string;
  connectionId: string;
  projectKey: string;
  folderId?: number;
  pageSize?: number;
}

export interface SavedConnectionTestRailPull {
  source: "testrail";
  label?: string;
  connectionId: string;
  projectId: number;
  suiteId?: number;
  pageSize?: number;
}

export type ConnectorPullRequest =
  | ({ source: "jira"; label?: string } & JiraConnectorConfig)
  | ({ source: "xray"; label?: string } & XrayConnectorConfig)
  | ({ source: "zephyr"; label?: string } & ZephyrConnectorConfig)
  | ({ source: "testrail"; label?: string } & TestRailConnectorConfig)
  | SavedConnectionXrayPull
  | SavedConnectionZephyrPull
  | SavedConnectionTestRailPull;

export interface ExportRequest {
  runId: string;
  target: ExportTarget;
  suggestionIds?: string[];
  overrideLowConfidence?: boolean;
  /**
   * Connection config required for external targets (github/xray/zephyr/
   * testrail/jira). Ignored for excel/gherkin file exports.
   */
  connection?: Record<string, unknown>;
  /** Per-target export options (e.g. projectKey, sectionId, repo). */
  options?: Record<string, unknown>;
}

export interface ExporterPushResultDto {
  created: Array<{ suggestionId: string; externalId: string }>;
  failed: Array<{ suggestionId: string; reason: string }>;
  skipped: Array<{ suggestionId: string; reason: string }>;
}

export type ExportRunResult =
  | { kind: "file"; blob: Blob; filename: string }
  | { kind: "push"; result: ExporterPushResultDto };

export const testCoverageApi = {
  // ---- imports ----------------------------------------------------------
  listImports: (projectId: string) =>
    apiFetch<TestImportSummary[]>(`/projects/${projectId}/test-coverage/imports`),

  uploadImport: async (projectId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/projects/${projectId}/test-coverage/imports`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!res.ok) {
      const json = await safeJson(res);
      throw new Error(json?.error?.message ?? `Upload failed (${res.status})`);
    }
    const json = (await res.json()) as { data: TestImportSummary };
    return json.data;
  },

  pasteImport: (
    projectId: string,
    body: {
      source: "csv" | "markdown" | "gherkin";
      text: string;
      label: string;
      columnOverrides?: Record<string, string>;
    },
  ) =>
    apiFetch<TestImportSummary>(`/projects/${projectId}/test-coverage/imports/paste`, {
      method: "POST",
      body,
    }),

  // ---- runs --------------------------------------------------------------
  listRuns: (projectId: string) =>
    apiFetch<TestCoverageRun[]>(`/projects/${projectId}/test-coverage/runs`),

  getRun: (projectId: string, runId: string) =>
    apiFetch<TestCoverageRun>(`/projects/${projectId}/test-coverage/runs/${runId}`),

  createRun: (projectId: string, body: { budgetCents?: number; modelTag?: string } = {}) =>
    apiFetch<TestCoverageRun>(`/projects/${projectId}/test-coverage/runs`, {
      method: "POST",
      body,
    }),

  getReport: (projectId: string, runId: string) =>
    apiFetch<RunReport>(`/projects/${projectId}/test-coverage/runs/${runId}/report`),

  getBudget: (projectId: string, runId: string) =>
    apiFetch<RunBudgetState>(`/projects/${projectId}/test-coverage/runs/${runId}/budget`),

  // ---- updates ----------------------------------------------------------
  overrideMapping: (
    projectId: string,
    mappingId: string,
    body: { status: "COVERED" | "UNCOVERED" | "AMBIGUOUS"; reason?: string },
  ) =>
    apiFetch<CoverageMappingDto>(`/projects/${projectId}/test-coverage/mappings/${mappingId}`, {
      method: "PATCH",
      body,
    }),

  updateSuggestion: (
    projectId: string,
    suggestionId: string,
    body: { status: "accepted" | "rejected" | "exported"; reason?: string },
  ) =>
    apiFetch<SuggestionDto>(`/projects/${projectId}/test-coverage/suggestions/${suggestionId}`, {
      method: "PATCH",
      body,
    }),

  // ---- exports ----------------------------------------------------------
  exportRun: async (projectId: string, req: ExportRequest): Promise<ExportRunResult> => {
    const res = await fetch(`${API_BASE}/projects/${projectId}/test-coverage/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      credentials: "same-origin",
    });
    if (!res.ok) {
      const json = await safeJson(res);
      const err = new Error(json?.error?.message ?? `Export failed (${res.status})`) as Error & {
        code?: string;
        details?: unknown;
      };
      err.code = json?.error?.code;
      err.details = json?.error?.details;
      throw err;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const json = (await res.json()) as { data: ExporterPushResultDto };
      return { kind: "push", result: json.data };
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^";]+)"?/i.exec(cd);
    const filename = match?.[1] ?? `coverage-${req.runId}.bin`;
    return { kind: "file", blob, filename };
  },

  // ---- connector imports -------------------------------------------------
  pullFromConnector: (projectId: string, body: ConnectorPullRequest) =>
    apiFetch<TestImportSummary>(`/projects/${projectId}/test-coverage/imports/${body.source}`, {
      method: "POST",
      body,
    }),
};

async function safeJson(res: Response): Promise<{
  error?: { code?: string; message?: string; details?: unknown };
} | null> {
  try {
    return (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
  } catch {
    return null;
  }
}

/** Trigger a browser download for the blob produced by `exportRun`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
