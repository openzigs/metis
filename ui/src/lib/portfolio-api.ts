/**
 * Epic #1608 (#1626) — typed wrappers around `/api/portfolio-assessments`
 * (#1625): a requirement checked across the product portfolio.
 *
 * The server owns access: every read is re-filtered against the reader's
 * access now, so a product they cannot read arrives `restricted` and empty.
 */
import { apiFetch, streamFetch } from "@/lib/api-client";
import { filenameFromDisposition, parseStreamError } from "@/lib/plugins-api";
import type {
  CreatePortfolioAssessmentInput,
  PortfolioAssessmentListItem,
  PortfolioAssessmentView,
} from "@metis/shared";

const BASE = "/portfolio-assessments";

export const portfolioApi = {
  /** Start an assessment; the run is async and reports on `job:{id}`. */
  create: (body: CreatePortfolioAssessmentInput) =>
    apiFetch<{ id: string }>(BASE, { method: "POST", body }),

  get: (id: string) => apiFetch<PortfolioAssessmentView>(`${BASE}/${encodeURIComponent(id)}`),

  /** The newest assessments naming `productId`, or else the caller's own. */
  list: (productId?: string) =>
    productId
      ? apiFetch<PortfolioAssessmentListItem[]>(BASE, { params: { productId } })
      : apiFetch<PortfolioAssessmentListItem[]>(BASE),

  /**
   * #1627 — the reader's view as Markdown (#1624): `GET …/:id/export?format=md`.
   * The body is raw Markdown, not the `{ success, data }` envelope, so it is
   * read as a blob.
   */
  async exportMarkdown(id: string): Promise<{ blob: Blob; filename: string }> {
    const res = await streamFetch(`${BASE}/${encodeURIComponent(id)}/export`, {
      method: "GET",
      params: { format: "md" },
      headers: { Accept: "text/markdown" },
    });
    if (!res.ok) throw new Error(await parseStreamError(res));
    const blob = await res.blob();
    return {
      blob,
      filename: filenameFromDisposition(
        res.headers.get("content-disposition"),
        `portfolio-assessment-${id}.md`,
      ),
    };
  },
};
