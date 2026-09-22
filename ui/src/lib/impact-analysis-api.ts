/**
 * Typed wrappers around the multi-project impact-analysis REST endpoints —
 * Epic #159 (#163/#164/#166).
 *
 * A single impact analysis spans many projects, so these endpoints are
 * top-level (`/api/impact-analyses`) rather than project-scoped.
 */
import { apiFetch, streamFetch } from "@/lib/api-client";
import { filenameFromDisposition, parseStreamError } from "@/lib/plugins-api";
import type {
  CreateImpactAnalysisInput,
  CreateImpactAnalysisResponse,
  ImpactAnalysisDetail,
  ImpactAnalysisSummary,
  ImpactDriftReport,
  ImpactTableFeedbackInput,
  ImpactTableFeedbackView,
  SchemaUsageClassificationView,
} from "@metis/shared";

/** Issue #965 — the 202 response of `POST /impact-analyses/:id/rerun`. */
export interface ImpactRerunResponse extends CreateImpactAnalysisResponse {
  /** The original run this re-run re-executes. */
  rerunOfId: string;
}

const BASE = "/impact-analyses";

/** #963 — the published Jira issue reference returned by the publish endpoint. */
export interface ImpactJiraPublishResult {
  provider: "jira";
  issueKey: string;
  url: string;
}

export const impactAnalysisApi = {
  create: (body: CreateImpactAnalysisInput) =>
    apiFetch<CreateImpactAnalysisResponse>(BASE, { method: "POST", body }),

  /** #61 — `projectId` narrows the list to runs that include that project. */
  list: (projectId?: string) =>
    projectId
      ? apiFetch<ImpactAnalysisSummary[]>(BASE, { params: { projectId } })
      : apiFetch<ImpactAnalysisSummary[]>(BASE),

  get: (id: string) => apiFetch<ImpactAnalysisDetail>(`${BASE}/${id}`),

  /**
   * Epic #292 (#298) — read the persisted used/unreferenced/uncertain schema
   * usage classification for one project.
   */
  usageClassification: (projectId: string) =>
    apiFetch<SchemaUsageClassificationView[]>(
      `${BASE}/projects/${encodeURIComponent(projectId)}/usage-classification`,
    ),

  /**
   * Issue #963 — download the impact run as a markdown report. Streams a raw
   * markdown body (NOT the `{ success, data }` envelope), so it goes through
   * streamFetch + reads the blob, mirroring the analysis-report export.
   */
  async exportReport(id: string): Promise<{ blob: Blob; filename: string }> {
    const res = await streamFetch(`${BASE}/${encodeURIComponent(id)}/export.md`, {
      method: "GET",
      headers: { Accept: "text/markdown" },
    });
    if (!res.ok) {
      throw new Error(await parseStreamError(res));
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("content-disposition"),
      `impact-analysis-${id}.md`,
    );
    return { blob, filename };
  },

  /**
   * Issue #963 — publish the impact run to Jira as ONE issue (idempotent). An
   * explicit `projectId` bills the issue to a specific run project; omit it to
   * use the first configured run project.
   */
  publishToJira: (id: string, body: { projectId?: string } = {}) =>
    apiFetch<ImpactJiraPublishResult>(`${BASE}/${encodeURIComponent(id)}/publish/jira`, {
      method: "POST",
      body,
    }),

  /**
   * Issue #966 — mark (or re-mark) an affected-table row relevant/not-relevant.
   * Idempotent per (item, table, column, caller) — a repeat call updates the
   * existing mark rather than duplicating it.
   */
  markTableFeedback: (analysisId: string, itemId: string, body: ImpactTableFeedbackInput) =>
    apiFetch<ImpactTableFeedbackView>(
      `${BASE}/${encodeURIComponent(analysisId)}/items/${encodeURIComponent(itemId)}/feedback`,
      { method: "POST", body },
    ),

  /** Issue #966 — remove a feedback mark (only the caller's own mark). */
  deleteTableFeedback: (analysisId: string, itemId: string, feedbackId: string) =>
    apiFetch<void>(
      `${BASE}/${encodeURIComponent(analysisId)}/items/${encodeURIComponent(itemId)}/feedback/${encodeURIComponent(feedbackId)}`,
      { method: "DELETE" },
    ),

  /**
   * Issue #965 — re-run a completed analysis against the CURRENT code graph. The
   * new run reuses the original's stored source verbatim and links back via
   * `rerunOfId`; the original is never mutated. 202 Accepted — poll the new run.
   */
  rerun: (id: string) =>
    apiFetch<ImpactRerunResponse>(`${BASE}/${encodeURIComponent(id)}/rerun`, { method: "POST" }),

  /**
   * Issue #965 — the deterministic drift report for a run vs the original it
   * re-executes (its `rerunOfId` parent). An original run (no parent) returns an
   * empty report.
   */
  drift: (id: string) => apiFetch<ImpactDriftReport>(`${BASE}/${encodeURIComponent(id)}/drift`),
};
