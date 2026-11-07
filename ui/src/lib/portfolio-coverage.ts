/**
 * Epic #1608 (#1626) — what the portfolio coverage page says about one
 * assessment, as pure functions of the reader's view (`GET
 * /portfolio-assessments/:id`).
 *
 * Nothing here recomputes a verdict: the server already rolled the reader's
 * view up (#1622, re-filtered per reader by #1625). This only turns it into
 * plain words, one row per product in scope, and repo-stamped citations.
 */
import {
  portfolioModelErrorText,
  portfolioNamedInProse,
  type CodeCitation,
  type PortfolioAssessmentView,
  type PortfolioCoverage,
} from "@metis/shared";

type Product = PortfolioAssessmentView["products"][number];

/** A coverage state's words. Shown as text, never as colour alone. */
export const COVERAGE_LABEL: Record<PortfolioCoverage, string> = {
  covers: "Covers it",
  partial: "Partly covers it",
  "not-covered": "Does not cover it",
  "not-checked": "Not checked",
  restricted: "Restricted",
};

/** Why a product was not checked, in the words a business analyst reads. */
const NOT_CHECKED_REASON: Record<string, string> = {
  "no-repos": "it has no repositories attached",
  "repos-restricted": "you cannot read its repositories",
  "could-not-verify": "the evidence could not be verified",
  pending: "the check has not reached it yet",
  failed: "the assessment failed before it was checked",
};

interface StoredRepo {
  repoConnectionId: string;
  label: string;
  verdict: string;
  criteria: string[];
  /** Why it was not verified (`model-error`, …), or null. */
  reason: string | null;
}

/** The repos the gap engine stored for a product (`technicalDetail.repos`). */
export function storedRepos(product: Pick<Product, "technicalDetail">): StoredRepo[] {
  const repos = (product.technicalDetail as { repos?: unknown }).repos;
  if (!Array.isArray(repos)) return [];
  return repos.flatMap((r) => {
    if (typeof r !== "object" || r === null) return [];
    const { repoConnectionId, label, verdict, criteria, reason } = r as Record<string, unknown>;
    if (typeof repoConnectionId !== "string" || typeof label !== "string") return [];
    return [
      {
        repoConnectionId,
        label,
        verdict: typeof verdict === "string" ? verdict : "",
        criteria: Array.isArray(criteria)
          ? criteria.filter((c): c is string => typeof c === "string")
          : [],
        reason: typeof reason === "string" ? reason : null,
      },
    ];
  });
}

/** #1726 — the labels of a product's repos whose model call failed. */
function failedRepos(repos: readonly StoredRepo[]): string[] {
  return repos.filter((r) => r.reason === "model-error").map((r) => r.label);
}

/** One citation, stamped with the repo it is in. */
export interface RepoCitation {
  repo: string;
  location: string;
}

/** One row of the coverage matrix. */
export interface CoverageRow {
  productId: string;
  /** Null for a product the reader cannot read: it carries no name. */
  name: string | null;
  coverage: PortfolioCoverage;
  /** Why it was not checked; null for every other state. */
  reason: string | null;
  /** The repos whose evidence covers it, for the headline. */
  coveringRepos: string[];
  /** #1726 — the repos whose model call failed, so the answer leaves them out. */
  failedRepos: string[];
  citations: RepoCitation[];
}

function reasonFor(product: Product | undefined, status: PortfolioAssessmentView["status"]) {
  if (!product) return NOT_CHECKED_REASON[status === "failed" ? "failed" : "pending"];
  // #1726 — a failed model call is not "the evidence could not be verified": it
  // says so and what to do, and keeps the gap another repo confirmed.
  const repos = storedRepos(product);
  const failed = failedRepos(repos);
  if (failed.length > 0) {
    const gaps = repos.filter((r) => r.verdict === "gap-confirmed").map((r) => r.label);
    return [
      `the check failed (model error) on ${portfolioNamedInProse(failed)}; re-run to retry`,
      ...(gaps.length > 0
        ? [`${portfolioNamedInProse(gaps)} ${gaps.length === 1 ? "does" : "do"} not cover it`]
        : []),
    ].join(". ");
  }
  const stored = (product.technicalDetail as { reason?: unknown }).reason;
  return (typeof stored === "string" && NOT_CHECKED_REASON[stored]) || "it was not checked";
}

function citationsFor(
  view: PortfolioAssessmentView,
  productId: string,
  labels: ReadonlyMap<string, string>,
): RepoCitation[] {
  return view.repos
    .filter((r) => r.productId === productId)
    .flatMap((r) =>
      (r.citations as CodeCitation[]).map((c) => ({
        repo: labels.get(c.repoConnectionId ?? r.repoConnectionId) ?? "Unnamed repository",
        location: `${c.filePath}:${c.startLine}`,
      })),
    );
}

/**
 * Every product the assessment was scoped to, in scope order, each with an
 * explicit state. A product the run has not written a row for yet (the run is
 * pending or running, or it failed) is `not-checked` with the reason; nothing
 * in scope is ever left out. Products the impact walk reached outside the
 * scope (#1623) are not part of the coverage answer and are not listed here.
 */
export function coverageRows(view: PortfolioAssessmentView): CoverageRow[] {
  const byId = new Map(view.products.map((p) => [p.productId, p]));
  return view.productIds.map((productId) => {
    const product = byId.get(productId);
    const coverage: PortfolioCoverage = product?.coverage ?? "not-checked";
    if (coverage === "restricted") {
      return {
        productId,
        name: null,
        coverage,
        reason: null,
        coveringRepos: [],
        failedRepos: [],
        citations: [],
      };
    }
    const repos = product ? storedRepos(product) : [];
    const labels = new Map(repos.map((r) => [r.repoConnectionId, r.label]));
    const covering =
      coverage === "covers" || coverage === "partial"
        ? repos
            .filter((r) => r.verdict === "implemented" || r.criteria.includes("implemented"))
            .map((r) => r.label)
        : [];
    return {
      productId,
      name: view.productNames[productId] ?? null,
      coverage,
      reason: coverage === "not-checked" ? reasonFor(product, view.status) : null,
      coveringRepos: covering,
      failedRepos: failedRepos(repos),
      citations: product ? citationsFor(view, productId, labels) : [],
    };
  });
}

function named(rows: CoverageRow[]): string {
  return rows
    .map((r) => {
      const name = r.name ?? "a product";
      return r.coveringRepos.length > 0 ? `${name} (${r.coveringRepos.join(", ")})` : name;
    })
    .join(", ");
}

/** The tone of the headline, so it is not conveyed by colour alone. */
export type HeadlineTone = "covered" | "partial" | "gap" | "unknown";

export interface CoverageHeadline {
  tone: HeadlineTone;
  text: string;
  /** A second sentence under the answer, when it needs one. */
  note?: string;
}

/**
 * #1677 — the products in scope with no repositories at all. The verdict
 * leaves them out (there was nothing in them to check), so a confirmed gap
 * names them rather than hiding them.
 */
function nothingToCheck(view: PortfolioAssessmentView, rows: CoverageRow[]): CoverageRow[] {
  const empty = new Set(
    view.products
      .filter(
        (p) =>
          p.coverage === "not-checked" &&
          (p.technicalDetail as { reason?: unknown }).reason === "no-repos",
      )
      .map((p) => p.productId),
  );
  return rows.filter((r) => empty.has(r.productId));
}

/**
 * The answer in one plain sentence, or null while the run has not finished
 * (the page shows progress instead).
 */
export function coverageHeadline(view: PortfolioAssessmentView): CoverageHeadline | null {
  const headline = verdictHeadline(view);
  if (!headline || view.status !== "completed") return headline;
  // #1726 — a repo whose model call failed is left out of the answer: say so.
  const failed = [...new Set(coverageRows(view).flatMap((r) => r.failedRepos))];
  if (failed.length === 0) return headline;
  const said = portfolioModelErrorText(failed, { leftOut: true });
  return { ...headline, note: headline.note ? `${headline.note} ${said}` : said };
}

function verdictHeadline(view: PortfolioAssessmentView): CoverageHeadline | null {
  if (view.status === "failed") {
    return { tone: "unknown", text: "This check failed before it reached an answer" };
  }
  if (view.status !== "completed" || view.verdict === null) return null;
  const rows = coverageRows(view);
  switch (view.verdict) {
    case "implemented":
      return {
        tone: "covered",
        text: `Covered by ${named(rows.filter((r) => r.coverage === "covers"))}`,
      };
    case "partial":
      return {
        tone: "partial",
        text: `Partly covered by ${named(rows.filter((r) => r.coverage === "partial"))}`,
      };
    case "gap-confirmed": {
      const empty = nothingToCheck(view, rows);
      const outside = notInScopeNote(view, rows);
      const notes = [
        ...(outside ? [outside] : []),
        ...(empty.length > 0
          ? [
              // #1685 — three names, then "and N more"; #1689 — the server's helper.
              `${portfolioNamedInProse(
                empty.map((r) => r.name),
                { sentenceStart: true },
              )} ${empty.length === 1 ? "has" : "have"} no repositories, so there was nothing in ${empty.length === 1 ? "it" : "them"} to check.`,
            ]
          : []),
      ];
      return {
        tone: "gap",
        // #1963 — a gap over the products in scope of the change, not the whole portfolio.
        text: outside
          ? "Nothing that was checked covers this"
          : "Nothing in your portfolio covers this",
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };
    }
    default: {
      const outside = notInScopeNote(view, rows);
      return {
        tone: "unknown",
        text: "We could not tell whether anything in your portfolio covers this",
        ...(outside ? { note: outside } : {}),
      };
    }
  }
}

/**
 * #1963 — the products the verdict left out (`view.notInScope`): not checked,
 * and not reached by the change, so not what made the answer unknown.
 */
function notInScopeNote(view: PortfolioAssessmentView, rows: CoverageRow[]): string | null {
  const ids = new Set(view.notInScope ?? []);
  const outside = rows.filter((r) => ids.has(r.productId));
  if (outside.length === 0) return null;
  const one = outside.length === 1;
  return `${portfolioNamedInProse(
    outside.map((r) => r.name),
    { sentenceStart: true },
  )} ${one ? "was" : "were"} not checked, but this change does not reach ${one ? "it" : "them"}, so ${one ? "it is" : "they are"} not in scope.`;
}
