/**
 * Epic #1608 (#1626) — typed wrappers around `/api/portfolio-assessments`
 * (#1625): a requirement checked across the product portfolio.
 *
 * The server owns access: every read is re-filtered against the reader's
 * access now, so a product they cannot read arrives `restricted` and empty.
 */
import { apiFetch } from "@/lib/api-client";
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
};
