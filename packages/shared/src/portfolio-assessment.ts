/**
 * Epic #1608 (#1621) — a requirement assessed across the product portfolio:
 * which products cover it, and which it would change or reach downstream.
 *
 * The persisted shape. The engines that fill it are #1622 (gap analysis) and
 * #1623 (impact propagation and severity); the routes are #1625.
 */
import { z } from "zod";
import { REQUIREMENT_KINDS, REQUIREMENT_VERDICTS } from "./constants.js";
import { NFR_CATEGORIES } from "./elicitation.js";
import { PRODUCT_INTEGRATION_KINDS, type ProductResourceKind } from "./product-docs.js";
import type { ChangeRequestRef } from "./impact.js";

/**
 * Which products an assessment looked at: the products chosen (`product`: one or
 * several, #2272), or every one the caller can read.
 */
export const PORTFOLIO_ASSESSMENT_SCOPES = ["product", "all-accessible"] as const;
export type PortfolioAssessmentScope = (typeof PORTFOLIO_ASSESSMENT_SCOPES)[number];

export const PORTFOLIO_ASSESSMENT_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type PortfolioAssessmentStatus = (typeof PORTFOLIO_ASSESSMENT_STATUSES)[number];

/**
 * How far a product already covers the requirement. `not-checked`: the
 * assessment did not get to it (budget, error); `restricted`: the caller could
 * not read enough of it to say.
 */
export const PORTFOLIO_COVERAGES = [
  "covers",
  "partial",
  "not-covered",
  "not-checked",
  "restricted",
] as const;
export type PortfolioCoverage = (typeof PORTFOLIO_COVERAGES)[number];

/**
 * How the requirement reaches a product: it must change, or it consumes what
 * changes. #1673 — `restricted`: a product the reader can read whose impact
 * runs, or may run, through a product they cannot read: the walk stopped at a
 * restricted product and so could not rule it out, or the path to it is
 * withheld from this reader. Nothing of the path is given, and it is never
 * stated unaffected.
 */
export const PORTFOLIO_IMPACT_KINDS = [
  "direct-change",
  "downstream-consumer",
  "restricted",
  "none",
] as const;
export type PortfolioImpactKind = (typeof PORTFOLIO_IMPACT_KINDS)[number];

const jsonValue: z.ZodType<unknown> = z.unknown();

/** One product's part in an assessment. */
export const portfolioAssessmentProductInputSchema = z
  .object({
    productId: z.string().min(1).max(64),
    coverage: z.enum(PORTFOLIO_COVERAGES),
    impactKind: z.enum(PORTFOLIO_IMPACT_KINDS).default("none"),
    /** The integration kind the impact crosses (#1618 `PRODUCT_INTEGRATION_KINDS`). */
    via: z.string().min(1).max(32).nullable().default(null),
    edgeIds: z.array(z.string().min(1).max(64)).max(2_000).default([]),
    severity: z.string().min(1).max(32).nullable().default(null),
    baSummary: z.string().max(20_000).default(""),
    technicalDetail: z.record(z.string(), jsonValue).default({}),
  })
  .strict();
export type PortfolioAssessmentProductInput = z.input<typeof portfolioAssessmentProductInputSchema>;

/** One repo's verdict, under the product it was assessed for. */
export const portfolioAssessmentRepoInputSchema = z
  .object({
    productId: z.string().min(1).max(64),
    repoConnectionId: z.string().min(1).max(64),
    verdict: z.enum(REQUIREMENT_VERDICTS),
    /** Repo-aware code citations (#1611), stored as given. */
    citations: z.array(jsonValue).max(500).default([]),
  })
  .strict();
export type PortfolioAssessmentRepoInput = z.input<typeof portfolioAssessmentRepoInputSchema>;

/**
 * #1647 — the most an assessment may name. Generous for a whole portfolio
 * (#1621 measured 1,200 repos over 40 products) and still a bound on one write.
 */
export const PORTFOLIO_ASSESSMENT_LIMITS = {
  products: 2_000,
  repos: 20_000,
} as const;

// ─── #2272 — a document's requirements, and what a check did not check ──────

/**
 * #2272 — products a `product` scope may name: one, or several chosen ones.
 * More than this is an "all products" check (`all-accessible`).
 */
export const PORTFOLIO_ASSESSMENT_MAX_PRODUCTS = 50;
/** #2272 — requirements (or a requirement's criteria) one check takes. */
export const PORTFOLIO_MAX_REQUIREMENTS = 100;
/** Characters of one requirement (or criterion) checked. */
export const PORTFOLIO_REQUIREMENT_MAX_CHARS = 2_000;
/** Characters of the statement checked. */
export const PORTFOLIO_STATEMENT_MAX_CHARS = 8_000;

/**
 * #2272 — why something was not checked. Nothing is cut silently: each is
 * listed with the assessment, on the page and in the export.
 *
 * - `over-limit` — a requirement past the {@link PORTFOLIO_MAX_REQUIREMENTS} one check takes.
 * - `text-cut` — the characters of a requirement (or the statement) past what one may hold.
 * - `section-unread` — a document section the model could not read.
 * - `quote-not-found` — statements the model read that were dropped: their quote is not in the document.
 * - `budget` — the check's budget ran out before some repositories were checked for it.
 * - `restricted-source` — #2447: requirements of a change request resting on a
 *   document its starter cannot see, left out of the check. Counts only.
 */
export const PORTFOLIO_NOT_CHECKED_REASONS = [
  "over-limit",
  "text-cut",
  "section-unread",
  "quote-not-found",
  "budget",
  "restricted-source",
] as const;
export type PortfolioNotCheckedReason = (typeof PORTFOLIO_NOT_CHECKED_REASONS)[number];

/** Entries one assessment's not-checked list may hold. */
export const PORTFOLIO_NOT_CHECKED_MAX = 1_000;

export const portfolioNotCheckedSchema = z
  .object({
    /** What was not checked: the requirement, the section's heading, or the opening of the cut text. */
    text: z.string().max(PORTFOLIO_REQUIREMENT_MAX_CHARS),
    reason: z.enum(PORTFOLIO_NOT_CHECKED_REASONS),
    /** How many: characters cut, statements dropped, repositories not checked. */
    count: z.number().int().min(0).nullable().default(null),
  })
  .strict();
export type PortfolioNotChecked = z.output<typeof portfolioNotCheckedSchema>;
export type PortfolioNotCheckedInput = z.input<typeof portfolioNotCheckedSchema>;

/** #2272 — why an entry was not checked, in the words the page and the export share. */
export function portfolioNotCheckedText(
  item: Pick<PortfolioNotChecked, "reason" | "count">,
): string {
  const n = item.count ?? 0;
  switch (item.reason) {
    case "over-limit":
      return `Not checked: one check takes ${PORTFOLIO_MAX_REQUIREMENTS} requirements, and this one is past them.`;
    case "text-cut":
      return `Not checked in full: the last ${n.toLocaleString("en-US")} character${n === 1 ? "" : "s"} of this text ${n === 1 ? "is" : "are"} past what one check reads.`;
    case "section-unread":
      return "Not checked: the model could not read this section of the document.";
    case "quote-not-found":
      return `Not checked: ${n} statement${n === 1 ? " was" : "s were"} dropped because ${n === 1 ? "its" : "their"} quote is not in the document.`;
    case "budget":
      return `Not checked in ${n} ${n === 1 ? "repository" : "repositories"}: the check's budget ran out first.`;
    case "restricted-source":
      return n === 1
        ? "Not checked: it rests on a document the person who started this check cannot see."
        : "Not checked: they rest on documents the person who started this check cannot see.";
  }
}

/**
 * #2447 — the one line a check started from a change request shows its starter
 * when requirements resting on a document they cannot see were left out of it.
 * `null` when none was. Counts only: it never names a requirement.
 */
export function restrictedRequirementsLeftOutSentence(count: number): string | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  return count === 1
    ? "1 requirement was left out: it rests on a document you can't see."
    : `${count} requirements were left out: they rest on documents you can't see.`;
}

/**
 * #2272 — each requirement an assessment checked, with the products found
 * implementing it, read from the product rows' stored criteria
 * (`technicalDetail.criteria`). A product whose row carries no criteria (a
 * restricted one, or one the impact walk reached outside the scope) adds
 * nothing. Empty when no row carries any.
 */
export function portfolioRequirementCoverage(
  products: ReadonlyArray<{ productId: string; technicalDetail: Record<string, unknown> }>,
): Array<{ requirement: string; coveredBy: string[] }> {
  const out: Array<{ requirement: string; coveredBy: string[] }> = [];
  for (const p of products) {
    const criteria = (p.technicalDetail as { criteria?: unknown }).criteria;
    if (!Array.isArray(criteria)) continue;
    criteria.forEach((c: unknown, i) => {
      const { criterion, coveredBy } = (c ?? {}) as { criterion?: unknown; coveredBy?: unknown };
      if (typeof criterion !== "string") return;
      out[i] ??= { requirement: criterion, coveredBy: [] };
      if (Array.isArray(coveredBy) && coveredBy.length > 0) out[i].coveredBy.push(p.productId);
    });
  }
  return out.filter(Boolean);
}

// ─── #1624 — the business-analyst report ────────────────────────────────────

/** Where a report's prose came from: the model, or the deterministic template. */
export const PORTFOLIO_REPORT_SOURCES = ["model", "template"] as const;
export type PortfolioReportSource = (typeof PORTFOLIO_REPORT_SOURCES)[number];

/** One requirement the statement is restated as, functional or not (#1612 `kind`). */
export const portfolioReportRequirementSchema = z
  .object({
    text: z.string().trim().min(1).max(1_000),
    kind: z.enum(REQUIREMENT_KINDS),
    nfrCategory: z.enum(NFR_CATEGORIES).nullable().default(null),
    /** The products the text names: a reader who cannot read one is not shown it. */
    mentions: z.array(z.string().min(1).max(64)).max(200).default([]),
  })
  .strict();

/** One affected product's paragraph: functional, business and stakeholder impact. */
export const portfolioReportProductSchema = z
  .object({
    productId: z.string().min(1).max(64),
    /** `template` when the model gave no usable paragraph for this product. */
    source: z.enum(PORTFOLIO_REPORT_SOURCES).default("model"),
    functional: z.string().max(2_000).default(""),
    business: z.string().max(2_000).default(""),
    stakeholder: z.string().max(2_000).default(""),
    /** The products the paragraph names: a reader who cannot read one is not shown it. */
    mentions: z.array(z.string().min(1).max(64)).max(200).default([]),
  })
  .strict();

export const portfolioReportSchema = z
  .object({
    source: z.enum(PORTFOLIO_REPORT_SOURCES),
    /** The model was unavailable or its answer unusable: the template stands in. */
    degraded: z.boolean(),
    degradedReason: z.string().max(200).nullable().default(null),
    /** `template` when the requirements are the assessment's criteria, not the model's restatement. */
    requirementsSource: z.enum(PORTFOLIO_REPORT_SOURCES).default("template"),
    requirements: z.array(portfolioReportRequirementSchema).max(100).default([]),
    products: z
      .array(portfolioReportProductSchema)
      .max(PORTFOLIO_ASSESSMENT_LIMITS.products)
      .default([]),
    /** Sentences the entity post-check removed from the model's prose. */
    strippedSentences: z.number().int().min(0).default(0),
    /** Read time (#1625): the reader sees less than the run did, so the model's prose is withheld. */
    withheld: z.boolean().default(false),
  })
  .strict();
export type PortfolioReport = z.output<typeof portfolioReportSchema>;
export type PortfolioReportInput = z.input<typeof portfolioReportSchema>;

/** A whole assessment as the engine writes it. */
export const portfolioAssessmentInputSchema = z
  .object({
    statement: z.string().trim().min(1).max(20_000),
    sourceRequirementId: z.string().min(1).max(64).nullable().default(null),
    sourceProjectId: z.string().min(1).max(64).nullable().default(null),
    /** #2272 — the document whose requirements were checked; null for any other source. */
    sourceDocumentId: z.string().min(1).max(64).nullable().default(null),
    /** #2345 — the change request whose requirements are checked. */
    sourceAnalysisId: z.string().min(1).max(64).nullable().default(null),
    /** #2345 — a requirement checked was not approved when the check started. */
    preApproval: z.boolean().default(false),
    /**
     * #2301 — the stored requirements chosen to be checked, each one criterion,
     * in the order chosen; empty for any other source. All in `sourceProjectId`.
     */
    sourceRequirementIds: z
      .array(z.string().min(1).max(64))
      .max(PORTFOLIO_MAX_REQUIREMENTS)
      .default([]),
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    productIds: z.array(z.string().min(1).max(64)).max(PORTFOLIO_ASSESSMENT_LIMITS.products),
    status: z.enum(PORTFOLIO_ASSESSMENT_STATUSES).default("pending"),
    portfolioVerdict: z.enum(PORTFOLIO_COVERAGES).nullable().default(null),
    summary: z.string().max(20_000).default(""),
    /** #1624 — the BA report; null until one is written. */
    report: portfolioReportSchema.nullable().default(null),
    /** #1725 — the product chosen to build the requirement; null when none was. */
    hostProductId: z.string().min(1).max(64).nullable().default(null),
    costUsd: z.number().min(0).default(0),
    createdById: z.string().min(1).max(64),
    products: z
      .array(portfolioAssessmentProductInputSchema)
      .max(PORTFOLIO_ASSESSMENT_LIMITS.products)
      .default([]),
    repos: z
      .array(portfolioAssessmentRepoInputSchema)
      .max(PORTFOLIO_ASSESSMENT_LIMITS.repos)
      .default([]),
    /** #2272 — what the check did not check, each with why. */
    notChecked: z.array(portfolioNotCheckedSchema).max(PORTFOLIO_NOT_CHECKED_MAX).default([]),
  })
  .strict()
  // #1647 — the parts must agree: a `product` scope names at most
  // `PORTFOLIO_ASSESSMENT_MAX_PRODUCTS` products (#2272; one before it),
  // and every product row and repo verdict is under a product the assessment
  // says it assessed. (A duplicate row is left to the tables' unique keys,
  // which refuse the whole write.) #1623 — the one exception is a product the
  // impact walk reached outside the scope: its row is a `downstream-consumer`
  // (#1725: or a `direct-change`, a product holding the host's repo), it has no
  // repo verdicts, and it never enters the portfolio verdict.
  .superRefine((a, ctx) => {
    if (a.scope === "product" && a.productIds.length > PORTFOLIO_ASSESSMENT_MAX_PRODUCTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productIds"],
        message: `a product-scoped assessment names at most ${PORTFOLIO_ASSESSMENT_MAX_PRODUCTS} products`,
      });
    }
    const assessed = new Set(a.productIds);
    a.products.forEach((p, i) => {
      if (
        !assessed.has(p.productId) &&
        p.impactKind !== "downstream-consumer" &&
        p.impactKind !== "direct-change"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["products", i, "productId"],
          message: "a product row must be for a product in productIds",
        });
      }
    });
    a.repos.forEach((r, i) => {
      if (!assessed.has(r.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repos", i, "productId"],
          message: "a repo verdict must be under a product in productIds",
        });
      }
    });
  });
export type PortfolioAssessmentInput = z.input<typeof portfolioAssessmentInputSchema>;

/** An assessment as it reads back. */
export interface PortfolioAssessment {
  id: string;
  statement: string;
  /** Null once the requirement it started from was recreated or deleted. */
  sourceRequirementId: string | null;
  sourceProjectId: string | null;
  /** #2272 — the document whose requirements were checked; null for any other source. */
  sourceDocumentId: string | null;
  scope: PortfolioAssessmentScope;
  productIds: string[];
  status: PortfolioAssessmentStatus;
  portfolioVerdict: PortfolioCoverage | null;
  summary: string;
  /** #1624 — the BA report, or null for a run without one. */
  report: PortfolioReport | null;
  /**
   * #1725 — the product chosen to build the requirement, or null when none was
   * (or, in a reader's view, when the reader cannot read it).
   */
  hostProductId: string | null;
  costUsd: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  products: Array<Required<z.output<typeof portfolioAssessmentProductInputSchema>>>;
  repos: Array<Required<z.output<typeof portfolioAssessmentRepoInputSchema>>>;
  /** #2272 — what the check did not check, each with why; empty for a run before #2272. */
  notChecked: PortfolioNotChecked[];
  /** #2345 — the change request whose requirements were checked; null for any other source. */
  sourceAnalysisId?: string | null;
  /** #2345 — a requirement checked was not approved when the check started. */
  preApproval?: boolean;
  /** #2301 — the stored requirements chosen to be checked; empty for any other source. */
  sourceRequirementIds?: string[];
}

// ─── #1625 — the HTTP contract ──────────────────────────────────────────────

/**
 * `POST /api/portfolio-assessments`: exactly one of `statement`,
 * `requirementId`, (#2272) `documentId`, (#2345) `analysisId` and (#2301)
 * `requirementIds`, the last three of whose requirements are each checked; a `product` scope names one or several chosen products, up to
 * {@link PORTFOLIO_ASSESSMENT_MAX_PRODUCTS} (#2272; exactly one before), and an
 * `all-accessible` scope names none (#1657).
 */
export const createPortfolioAssessmentSchema = z
  .object({
    statement: z.string().trim().min(1).max(PORTFOLIO_STATEMENT_MAX_CHARS).optional(),
    requirementId: z.string().min(1).max(64).optional(),
    /** #2272 — a document: the model reads it, and each requirement it finds is checked. */
    documentId: z.string().min(1).max(64).optional(),
    /**
     * #2345 — a change request (analysis run): the server reads its draft and
     * approved requirements, with access, and checks each. Allowed before they
     * are approved; such a check is labelled as run on unapproved requirements.
     */
    analysisId: z.string().min(1).max(64).optional(),
    /**
     * #2301 — a chosen set of stored requirements, all in one project the
     * caller can read: each is one criterion of the check. More than
     * {@link PORTFOLIO_MAX_REQUIREMENTS} is refused, never cut.
     */
    requirementIds: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(PORTFOLIO_MAX_REQUIREMENTS)
      .refine((ids) => new Set(ids).size === ids.length, "Name each requirement once")
      .optional(),
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    productIds: z
      .array(z.string().min(1).max(64))
      .max(PORTFOLIO_ASSESSMENT_MAX_PRODUCTS)
      .optional(),
    /**
     * #1623 — the product chosen to host the requirement where nothing covers it:
     * it changes directly, and the impact walk starts from it. A `product` scope
     * may only name one of its own products.
     */
    hostProductId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.statement, v.requirementId, v.documentId, v.analysisId, v.requirementIds].filter(
        (x) => x !== undefined,
      ).length === 1,
    {
      message:
        "Give exactly one of statement, requirementId, documentId, analysisId and requirementIds",
      path: ["statement"],
    },
  )
  .refine((v) => v.scope !== "product" || (v.productIds?.length ?? 0) >= 1, {
    message: 'A "product" scope names at least one product',
    path: ["productIds"],
  })
  .refine(
    (v) =>
      v.scope !== "product" ||
      v.hostProductId === undefined ||
      (v.productIds ?? []).includes(v.hostProductId),
    {
      message: 'A "product" scope can only host the requirement on one of its own products',
      path: ["hostProductId"],
    },
  )
  .refine((v) => v.scope !== "all-accessible" || (v.productIds?.length ?? 0) === 0, {
    message: 'An "all-accessible" scope names no product',
    path: ["productIds"],
  });
export type CreatePortfolioAssessmentInput = z.input<typeof createPortfolioAssessmentSchema>;

/**
 * #2345 — the label a check started before its requirements were approved
 * carries wherever it is cited: its page, every list and the export.
 */
export const PORTFOLIO_PRE_APPROVAL_LABEL = "Run on unapproved requirements";

/** The portfolio verdict in the requirement-verdict vocabulary (#1622). */
export type PortfolioVerdict = (typeof REQUIREMENT_VERDICTS)[number];

/**
 * An assessment as one reader may see it (#1625): every product the reader
 * cannot read now is `restricted` and carries nothing, and the verdict and
 * summary are recomputed whenever the reader sees less than the run did.
 */
export interface PortfolioAssessmentView extends PortfolioAssessment {
  verdict: PortfolioVerdict | null;
  /**
   * #2345 — the change request it was started from, named for the link back;
   * null when there is none, it was deleted since, or the reader cannot read
   * its project.
   */
  changeRequest?: ChangeRequestRef | null;
  /** Names of the products in the assessment that the reader can read now. */
  productNames: Record<string, string>;
  /**
   * #1963 — the products in scope the verdict left out as not in scope of the
   * change: not checked, and not connected (no path of product edges, either
   * way, at any depth) to any product the change touches. Empty when none
   * was, or for a verdict stored before #1963 (which left none out).
   */
  notInScope?: string[];
  /**
   * #1963 — the products in scope not checked and never analysed (no completed
   * product analysis, so their integration edges were never detected): the
   * walk's `none` for them is not evidence the change does not reach them, so
   * they stay in the verdict. Empty when none was.
   */
  neverAnalysed?: string[];
}

/** One row of `GET /api/portfolio-assessments`. */
export interface PortfolioAssessmentListItem {
  id: string;
  statement: string;
  scope: PortfolioAssessmentScope;
  status: PortfolioAssessmentStatus;
  verdict: PortfolioVerdict | null;
  productCount: number;
  /**
   * #1749 — the product chosen to build the requirement, as the reader's view
   * has it (null when none was, or the reader cannot read it), so a check with
   * a host and one without read differently in a list.
   */
  hostProductId: string | null;
  /** #1749 — that product's name; null when there is no readable host. */
  hostProductName: string | null;
  /** #2345 — the change request whose requirements were checked; null for any other source. */
  sourceAnalysisId?: string | null;
  /** #2345 — run on requirements not all approved when it started. */
  preApproval?: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

// ─── #2272 — impact tiers ───────────────────────────────────────────────────

/**
 * #2272 — how sure a product's impact is, in five tiers:
 *
 * - `found-in-code` — a product that must change, whose code the check found
 *   covers or partly covers the requirement. The evidence is the code verdict,
 *   not a graph path: no path is walked to a product that must change.
 * - `verified` — by graph path, for a downstream product only: every hop of
 *   the path to it is an edge a person declared (or overrode), or one detected
 *   with confidence at least {@link PORTFOLIO_VERIFIED_CONFIDENCE}.
 * - `likely` — every hop at least {@link PORTFOLIO_LIKELY_CONFIDENCE}. For a
 *   product that must change: it was chosen to build it (or holds that
 *   product's repository), and no code of it was found yet.
 * - `possible` — a hop below {@link PORTFOLIO_LIKELY_CONFIDENCE}.
 * - `needs-review` — the path cannot be shown: the change may reach the
 *   product through one its reader cannot read, the path was withheld from
 *   them, or no stored path reads.
 */
export const PORTFOLIO_IMPACT_TIERS = [
  "found-in-code",
  "verified",
  "likely",
  "possible",
  "needs-review",
] as const;
export type PortfolioImpactTier = (typeof PORTFOLIO_IMPACT_TIERS)[number];

export const PORTFOLIO_IMPACT_TIER_LABEL: Readonly<Record<PortfolioImpactTier, string>> = {
  "found-in-code": "Found in code",
  verified: "Verified by graph path",
  likely: "Likely",
  possible: "Possible",
  "needs-review": "Needs review",
};

/** A detected edge at least this confident verifies its hop. */
export const PORTFOLIO_VERIFIED_CONFIDENCE = 0.8;
/** Below this a hop is a weak signal (the severity's low-confidence step, #1623). */
export const PORTFOLIO_LIKELY_CONFIDENCE = 0.5;

/**
 * #2272 — a product row's impact tier, from what its run stored; null for a
 * product the change does not reach (`none`).
 */
export function portfolioImpactTier(row: {
  coverage: PortfolioCoverage;
  impactKind: PortfolioImpactKind;
  technicalDetail: Record<string, unknown>;
}): PortfolioImpactTier | null {
  if (row.impactKind === "none") return null;
  if (row.impactKind === "restricted" || row.coverage === "restricted") return "needs-review";
  const detail = row.technicalDetail as { impactWithheld?: unknown; impact?: { hops?: unknown } };
  if (detail.impactWithheld === true) return "needs-review";
  if (row.impactKind === "direct-change") {
    // No graph path is walked to a product that must change: its evidence is the code verdict.
    return row.coverage === "covers" || row.coverage === "partial" ? "found-in-code" : "likely";
  }
  const hops = detail.impact?.hops;
  if (!Array.isArray(hops) || hops.length === 0) return "needs-review";
  let weakest = 1;
  for (const hop of hops) {
    const { origin, confidence } = (hop ?? {}) as { origin?: unknown; confidence?: unknown };
    if (origin === "declared" || origin === "overridden") continue;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "needs-review";
    weakest = Math.min(weakest, confidence);
  }
  if (weakest >= PORTFOLIO_VERIFIED_CONFIDENCE) return "verified";
  if (weakest >= PORTFOLIO_LIKELY_CONFIDENCE) return "likely";
  return "possible";
}

// ─── #1673 — wording the page and the Markdown export share ─────────────────

/** Why the BA summary is the deterministic template (`PortfolioReport.degradedReason`). */
export const PORTFOLIO_DEGRADED_REASON: Readonly<Record<string, string>> = {
  "model-unavailable": "no model is configured",
  "model-offline": "the model is offline",
  "model-error": "the model call failed",
  "model-unparseable": "the model's answer could not be read",
  "model-empty": "the model's answer was empty",
  "post-check-rejected":
    "every sentence the model wrote named something the assessment does not contain",
};

/**
 * #1689 — how many products a list in prose names before "and N more" (#1685:
 * the page's headline note and the server's BA summary both cap at this).
 */
export const PORTFOLIO_NAMED_IN_PROSE = 3;

/**
 * Product names as prose: "A", "A and B", "A, B and C", then "A, B, C and 2
 * more". A product with no name (null) is never named, nor stood in for by its
 * id: it is counted in "N more", and a list with no name at all reads "a
 * product" or "N products" ("A product" at the start of a sentence).
 */
export function portfolioNamedInProse(
  names: readonly (string | null)[],
  { sentenceStart = false }: { sentenceStart?: boolean } = {},
): string {
  const shown = names.filter((n): n is string => n !== null).slice(0, PORTFOLIO_NAMED_IN_PROSE);
  const rest = names.length - shown.length;
  if (shown.length === 0) {
    if (rest !== 1) return `${rest} products`;
    return sentenceStart ? "A product" : "a product";
  }
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * #1963 — products the verdict left out as not in scope of the change, in the
 * words the page's headline and the server's summary share.
 */
export function portfolioNotInScopeText(names: readonly (string | null)[]): string {
  const one = names.length === 1;
  return `${portfolioNamedInProse(names, { sentenceStart: true })} ${one ? "was" : "were"} not checked, but ${one ? "it is" : "they are"} not connected to any product this change touches, so ${one ? "it is" : "they are"} not in scope.`;
}

/**
 * #1963 — products not checked whose integrations were never analysed, so
 * nothing says whether the change reaches them: they stay in the verdict.
 */
export function portfolioNeverAnalysedText(names: readonly (string | null)[]): string {
  const one = names.length === 1;
  return `${portfolioNamedInProse(names, { sentenceStart: true })} ${one ? "was" : "were"} not checked and ${one ? "has" : "have"} never been analysed, so whether this change reaches ${one ? "it" : "them"} is not known.`;
}

/**
 * #1726 — repos whose model call failed (`model-error`), in the words the page
 * and the server's summaries share: what failed and what to do. With
 * `leftOut`, says the answer it follows leaves them out.
 */
export function portfolioModelErrorText(
  repoLabels: readonly string[],
  { leftOut = false }: { leftOut?: boolean } = {},
): string {
  const them = repoLabels.length === 1 ? "it" : "them";
  return `The check failed (model error) on ${portfolioNamedInProse(repoLabels)}${
    leftOut ? `, so this answer leaves ${them} out` : ""
  }; re-run to retry.`;
}

/**
 * #1689 — the rule a run relabelled readable products `restricted` by, as it
 * stored it (`technicalDetail.impact.restrictedRule`: from #1689 when its walk
 * stopped at a restricted product, from #1692 on every readable row):
 *
 * - `walk` — one the run's walk did not reach, but the same walk able to read
 *   every product and repo does.
 * - `adjacent` — an older rule (#1680, #1685): one connected to a product the
 *   walk stopped at. It could mark a product the walk never reaches, and miss
 *   one it does, so a check stored under it is worth running again.
 *
 * Null: no rule, or an unknown value. A run before #1680 stored none (it
 * relabelled every product it did not reach when it stopped at a restricted
 * product), and so did a run from #1680 to #1691 that stopped at none (it
 * relabelled nothing, even past a repo or an edge its starter could not read).
 */
export const PORTFOLIO_RESTRICTED_RULES = ["walk", "adjacent"] as const;
export type PortfolioRestrictedRule = (typeof PORTFOLIO_RESTRICTED_RULES)[number];

export function portfolioRestrictedRule(technicalDetail: unknown): PortfolioRestrictedRule | null {
  const rule = (technicalDetail as { impact?: { restrictedRule?: unknown } } | null | undefined)
    ?.impact?.restrictedRule;
  return PORTFOLIO_RESTRICTED_RULES.find((r) => r === rule) ?? null;
}

/**
 * #1695 — whether a stored impact (`technicalDetail.impact`) was relabelled
 * under a rule older than the current `walk`, so that a product it lists as not
 * affected may still be reached (`PORTFOLIO_NOT_AFFECTED_OLDER_RULE`): `adjacent`,
 * or no rule at all. A row with no stored impact says nothing about a rule.
 */
export function portfolioImpactUnderOlderRule(technicalDetail: unknown): boolean {
  const impact = (technicalDetail as { impact?: unknown } | null | undefined)?.impact;
  if (typeof impact !== "object" || impact === null || Array.isArray(impact)) return false;
  return portfolioRestrictedRule(technicalDetail) !== "walk";
}

/**
 * #1963 — the edge kinds the change reaches a product by, beyond the one its
 * shown path crosses (`via`): each distinct kind in the stored
 * `technicalDetail.impact.links`, in `PRODUCT_INTEGRATION_KINDS` order (an
 * unknown kind last, as stored). The path shows the most severe link; these
 * are the others, so a product reached by a database and an event says both.
 */
export function portfolioOtherLinkKinds(technicalDetail: unknown, via: string | null): string[] {
  const links = (technicalDetail as { impact?: { links?: unknown } } | null | undefined)?.impact
    ?.links;
  if (!Array.isArray(links)) return [];
  const kinds = new Set<string>();
  for (const l of links) {
    const kind = (l as { integrationKind?: unknown } | null)?.integrationKind;
    if (typeof kind === "string" && kind !== via) kinds.add(kind);
  }
  const rank = (k: string) => {
    const i = (PRODUCT_INTEGRATION_KINDS as readonly string[]).indexOf(k);
    return i === -1 ? PRODUCT_INTEGRATION_KINDS.length : i;
  };
  return [...kinds].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Why a `restricted` impact is not known, by the rule its run relabelled it under. */
export function portfolioRestrictedNote(rule: PortfolioRestrictedRule | null): string {
  switch (rule) {
    case "walk":
      return "The change may reach it through a repository or product that the person who ran the check cannot read, so the check could not follow it there, and whether the change reaches this one is not known.";
    case "adjacent":
      return "The check stopped at a product the person who ran it cannot read, and this one is connected to it, so whether the change reaches this one is not known. The check ran under an older rule for such connections: run it again for a more exact answer.";
    default:
      return "The check stopped at a product the person who ran it cannot read, so whether the change reaches this one is not known. The check ran before METIS looked for a connection to that product: run it again to find out whether there is one.";
  }
}

/**
 * #1689 — said of the "Not affected" products of a check stored under an
 * older rule (`portfolioImpactUnderOlderRule`), which could miss a product the
 * change reaches.
 */
export const PORTFOLIO_NOT_AFFECTED_OLDER_RULE =
  "This check ran under an older rule for products it could not follow, so a product listed as not affected may still be reached through a repository or product that the person who ran it cannot read. Run the check again to find out.";

/**
 * One stored severity modifier of an impact hop (#1623 `HopSeverity`), in
 * words. The breaking contract is read from the provider's latest contract
 * version, not from this requirement (#1668). An unknown kind is returned as
 * stored, so a caller that renders markup must escape the result.
 */
export function portfolioModifierText(m: { kind: string; confidence?: number }): string {
  if (m.kind === "breaking-contract") {
    return "+1 step because the provider's latest contract version made a breaking change";
  }
  if (m.kind === "low-confidence") {
    return `−1 step for low confidence (${m.confidence ?? "unknown"})`;
  }
  return m.kind;
}

/**
 * The deep-dive heading a shared resource of an impact hop is listed under, by
 * its `ProductResource.kind` (#1618). The tables and columns the usage
 * classifications found are listed under `table`'s heading.
 */
export const PORTFOLIO_RESOURCE_GROUPS: Readonly<Record<ProductResourceKind, string>> = {
  database: "Databases",
  table: "Tables and columns",
  topic: "Topics",
  "identity-provider": "Identity providers",
  bucket: "Buckets",
};

const OTHER_RESOURCES = "Other resources";

/** The heading for a resource kind, including one this build does not know. */
export function portfolioResourceGroup(kind: string): string {
  return (PORTFOLIO_RESOURCE_GROUPS as Record<string, string>)[kind] ?? OTHER_RESOURCES;
}

/** One deep-dive list of an impact hop's shared resources. */
export interface PortfolioResourceList {
  heading: string;
  /** `detail` is null where the heading already says what the item is. */
  items: Array<{ name: string; detail: string | null }>;
}

/**
 * #2183 — the resources of every stored link into a product
 * (`technicalDetail.impact.links[].resources`): the tables and topics each
 * classified edge the change reaches it by crosses, not only the shown path's.
 * Two edges between the same repos (one through `orders`, one through
 * `customers`) are one link carrying both. Each once, in stored order; a
 * malformed entry, and a row stored before #2183 (no `resources`), add none.
 */
export function portfolioLinkResources(
  technicalDetail: unknown,
): Array<{ kind: string; name: string }> {
  const links = (technicalDetail as { impact?: { links?: unknown } } | null | undefined)?.impact
    ?.links;
  if (!Array.isArray(links)) return [];
  const out = new Map<string, { kind: string; name: string }>();
  for (const l of links) {
    const resources = (l as { resources?: unknown } | null)?.resources;
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      const { kind, name } = (r ?? {}) as { kind?: unknown; name?: unknown };
      if (typeof kind !== "string" || typeof name !== "string") continue;
      const key = `${kind}\u0000${name}`;
      if (!out.has(key)) out.set(key, { kind, name });
    }
  }
  return [...out.values()];
}

/**
 * The resource a hop crosses (#1618 `ProductResource`) and the tables and
 * columns both ends use (#309), grouped under one heading per resource kind,
 * in a fixed order. The resource itself is left out when the usage
 * classifications already list it. #2183 — `alsoVia` are the resources of the
 * product's other links ({@link portfolioLinkResources}), each listed once.
 */
export function portfolioResourceLists(
  resource: { kind: string; name: string } | null,
  sharedObjects: ReadonlyArray<{
    schemaName: string | null;
    objectName: string;
    objectType: string;
    usageClass: string;
  }>,
  alsoVia: ReadonlyArray<{ kind: string; name: string }> = [],
): PortfolioResourceList[] {
  const lists = new Map<string, PortfolioResourceList["items"]>();
  const add = (heading: string, item: PortfolioResourceList["items"][number]) => {
    const items = lists.get(heading) ?? [];
    items.push(item);
    lists.set(heading, items);
  };
  const listed = new Set<string>();
  for (const r of [...(resource ? [resource] : []), ...alsoVia]) {
    const key = `${r.kind}\u0000${r.name}`;
    if (listed.has(key) || sharedObjects.some((o) => o.objectName === r.name)) continue;
    listed.add(key);
    const heading = portfolioResourceGroup(r.kind);
    add(heading, { name: r.name, detail: heading === OTHER_RESOURCES ? r.kind : null });
  }
  for (const o of sharedObjects) {
    add(PORTFOLIO_RESOURCE_GROUPS.table, {
      name: o.schemaName ? `${o.schemaName}.${o.objectName}` : o.objectName,
      detail: `${o.objectType}, ${o.usageClass}`,
    });
  }
  return [...Object.values(PORTFOLIO_RESOURCE_GROUPS), OTHER_RESOURCES].flatMap((heading) => {
    const items = lists.get(heading);
    return items ? [{ heading, items }] : [];
  });
}
