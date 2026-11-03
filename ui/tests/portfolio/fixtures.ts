/**
 * #1626 — portfolio assessment views shaped like `GET /portfolio-assessments/:id`
 * returns them (`server/src/lib/portfolio/assessment-view.ts`).
 */
import type { PortfolioAssessmentView, PortfolioCoverage } from "@metis/shared";

type Product = PortfolioAssessmentView["products"][number];
type Repo = PortfolioAssessmentView["repos"][number];

export function product(
  productId: string,
  coverage: PortfolioCoverage,
  detail: Record<string, unknown> = {},
  over: Partial<Product> = {},
): Product {
  return {
    productId,
    coverage,
    impactKind: "none",
    via: null,
    edgeIds: [],
    severity: null,
    baSummary: "",
    technicalDetail: detail,
    ...over,
  };
}

export function repoDetail(
  repos: Array<{ id: string; label: string; verdict: string; criteria?: string[] }>,
  reason: string | null = null,
): Record<string, unknown> {
  return {
    reason,
    criteria: [{ criterion: "pays by transfer", coveredBy: [] }],
    repos: repos.map((r) => ({
      repoConnectionId: r.id,
      label: r.label,
      verdict: r.verdict,
      criteria: r.criteria ?? [],
      reason: null,
      costUsd: 0,
    })),
    inaccessibleRepoCount: 0,
    costUsd: 0,
  };
}

export function repo(
  productId: string,
  repoConnectionId: string,
  verdict: Repo["verdict"],
  citations: Array<{ filePath: string; startLine: number; repoConnectionId?: string }> = [],
): Repo {
  return {
    productId,
    repoConnectionId,
    verdict,
    citations: citations.map((c) => ({ endLine: c.startLine, ...c })),
  };
}

export function view(over: Partial<PortfolioAssessmentView> = {}): PortfolioAssessmentView {
  return {
    id: "pa-0000000001",
    statement: "Customers can pay an invoice by bank transfer.",
    sourceRequirementId: null,
    sourceProjectId: null,
    scope: "all-accessible",
    productIds: [],
    status: "completed",
    portfolioVerdict: null,
    summary: "",
    report: null,
    hostProductId: null,
    costUsd: 0,
    createdById: "u1",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:05:00.000Z",
    products: [],
    repos: [],
    verdict: null,
    productNames: {},
    ...over,
  };
}

/** Five products in five states, as #1626's acceptance criterion names them. */
export function fiveStates(): PortfolioAssessmentView {
  return view({
    productIds: ["p-billing", "p-ledger", "p-crm", "p-hr", "p-secret"],
    verdict: "implemented",
    portfolioVerdict: "covers",
    productNames: {
      "p-billing": "Billing",
      "p-ledger": "Ledger",
      "p-crm": "CRM",
      "p-hr": "HR",
    },
    products: [
      product(
        "p-billing",
        "covers",
        repoDetail([
          { id: "r-pay", label: "acme/payments", verdict: "implemented" },
          { id: "r-docs", label: "acme/docs", verdict: "gap-confirmed" },
        ]),
      ),
      product(
        "p-ledger",
        "partial",
        repoDetail([
          { id: "r-ledger", label: "acme/ledger", verdict: "partial", criteria: ["implemented"] },
        ]),
      ),
      product(
        "p-crm",
        "not-covered",
        repoDetail([{ id: "r-crm", label: "acme/crm", verdict: "gap-confirmed" }]),
      ),
      product("p-hr", "not-checked", repoDetail([], "no-repos")),
      product("p-secret", "restricted"),
    ],
    repos: [
      repo("p-billing", "r-pay", "implemented", [
        { filePath: "src/transfer.ts", startLine: 42, repoConnectionId: "r-pay" },
        { filePath: "src/iban.ts", startLine: 7 },
      ]),
      repo("p-ledger", "r-ledger", "partial", [{ filePath: "lib/post.go", startLine: 3 }]),
      repo("p-crm", "r-crm", "gap-confirmed"),
    ],
  });
}
