/**
 * Epic #1608 (#1621) — a requirement assessed across the product portfolio:
 * which products cover it, and which it would change or reach downstream.
 *
 * The persisted shape. The engines that fill it are #1622 (gap analysis) and
 * #1623 (impact propagation and severity); the routes are #1625.
 */
import { z } from "zod";
import { REQUIREMENT_VERDICTS } from "./constants.js";

/** Which products an assessment looked at: one product, or every one the caller can read. */
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

/** How the requirement reaches a product: it must change, or it consumes what changes. */
export const PORTFOLIO_IMPACT_KINDS = ["direct-change", "downstream-consumer", "none"] as const;
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
    edgeIds: z.array(z.string().min(1).max(64)).default([]),
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
    citations: z.array(jsonValue).default([]),
  })
  .strict();
export type PortfolioAssessmentRepoInput = z.input<typeof portfolioAssessmentRepoInputSchema>;

/** A whole assessment as the engine writes it. */
export const portfolioAssessmentInputSchema = z
  .object({
    statement: z.string().trim().min(1).max(20_000),
    sourceRequirementId: z.string().min(1).max(64).nullable().default(null),
    sourceProjectId: z.string().min(1).max(64).nullable().default(null),
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    productIds: z.array(z.string().min(1).max(64)),
    status: z.enum(PORTFOLIO_ASSESSMENT_STATUSES).default("pending"),
    portfolioVerdict: z.enum(PORTFOLIO_COVERAGES).nullable().default(null),
    summary: z.string().max(20_000).default(""),
    costUsd: z.number().min(0).default(0),
    createdById: z.string().min(1).max(64),
    products: z.array(portfolioAssessmentProductInputSchema).default([]),
    repos: z.array(portfolioAssessmentRepoInputSchema).default([]),
  })
  .strict();
export type PortfolioAssessmentInput = z.input<typeof portfolioAssessmentInputSchema>;

/** An assessment as it reads back. */
export interface PortfolioAssessment {
  id: string;
  statement: string;
  /** Null once the requirement it started from was recreated or deleted. */
  sourceRequirementId: string | null;
  sourceProjectId: string | null;
  scope: PortfolioAssessmentScope;
  productIds: string[];
  status: PortfolioAssessmentStatus;
  portfolioVerdict: PortfolioCoverage | null;
  summary: string;
  costUsd: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  products: Array<Required<z.output<typeof portfolioAssessmentProductInputSchema>>>;
  repos: Array<Required<z.output<typeof portfolioAssessmentRepoInputSchema>>>;
}
