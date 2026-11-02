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
import type { ProductResourceKind } from "./product-docs.js";

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
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    productIds: z.array(z.string().min(1).max(64)).max(PORTFOLIO_ASSESSMENT_LIMITS.products),
    status: z.enum(PORTFOLIO_ASSESSMENT_STATUSES).default("pending"),
    portfolioVerdict: z.enum(PORTFOLIO_COVERAGES).nullable().default(null),
    summary: z.string().max(20_000).default(""),
    /** #1624 — the BA report; null until one is written. */
    report: portfolioReportSchema.nullable().default(null),
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
  })
  .strict()
  // #1647 — the parts must agree: a `product` scope names at most one product,
  // and every product row and repo verdict is under a product the assessment
  // says it assessed. (A duplicate row is left to the tables' unique keys,
  // which refuse the whole write.) #1623 — the one exception is a product the
  // impact walk reached outside the scope: its row is a `downstream-consumer`,
  // it has no repo verdicts, and it never enters the portfolio verdict.
  .superRefine((a, ctx) => {
    if (a.scope === "product" && a.productIds.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productIds"],
        message: "a product-scoped assessment names at most one product",
      });
    }
    const assessed = new Set(a.productIds);
    a.products.forEach((p, i) => {
      if (!assessed.has(p.productId) && p.impactKind !== "downstream-consumer") {
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
  scope: PortfolioAssessmentScope;
  productIds: string[];
  status: PortfolioAssessmentStatus;
  portfolioVerdict: PortfolioCoverage | null;
  summary: string;
  /** #1624 — the BA report, or null for a run without one. */
  report: PortfolioReport | null;
  costUsd: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  products: Array<Required<z.output<typeof portfolioAssessmentProductInputSchema>>>;
  repos: Array<Required<z.output<typeof portfolioAssessmentRepoInputSchema>>>;
}

// ─── #1625 — the HTTP contract ──────────────────────────────────────────────

/**
 * Ids a request may carry: a `product` scope names exactly one (#1622), and an
 * `all-accessible` one names none (#1657: a list it would ignore is refused, so
 * the contract says what it accepts).
 */
export const PORTFOLIO_ASSESSMENT_MAX_PRODUCTS = 1;

/**
 * `POST /api/portfolio-assessments`: exactly one of `statement` and
 * `requirementId`; a `product` scope names exactly one product (#1622, #1647)
 * and an `all-accessible` scope names none (#1657).
 */
export const createPortfolioAssessmentSchema = z
  .object({
    statement: z.string().trim().min(1).max(8_000).optional(),
    requirementId: z.string().min(1).max(64).optional(),
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    productIds: z
      .array(z.string().min(1).max(64))
      .max(PORTFOLIO_ASSESSMENT_MAX_PRODUCTS)
      .optional(),
    /**
     * #1623 — the product chosen to host the requirement where nothing covers it:
     * it changes directly, and the impact walk starts from it. A `product` scope
     * may only name its own product.
     */
    hostProductId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => (v.statement === undefined) !== (v.requirementId === undefined), {
    message: "Give exactly one of statement and requirementId",
    path: ["statement"],
  })
  .refine((v) => v.scope !== "product" || v.productIds?.length === 1, {
    message: 'A "product" scope names exactly one product',
    path: ["productIds"],
  })
  .refine(
    (v) =>
      v.scope !== "product" ||
      v.hostProductId === undefined ||
      v.hostProductId === v.productIds?.[0],
    {
      message: 'A "product" scope can only host the requirement on its own product',
      path: ["hostProductId"],
    },
  )
  .refine((v) => v.scope !== "all-accessible" || (v.productIds?.length ?? 0) === 0, {
    message: 'An "all-accessible" scope names no product',
    path: ["productIds"],
  });
export type CreatePortfolioAssessmentInput = z.input<typeof createPortfolioAssessmentSchema>;

/** The portfolio verdict in the requirement-verdict vocabulary (#1622). */
export type PortfolioVerdict = (typeof REQUIREMENT_VERDICTS)[number];

/**
 * An assessment as one reader may see it (#1625): every product the reader
 * cannot read now is `restricted` and carries nothing, and the verdict and
 * summary are recomputed whenever the reader sees less than the run did.
 */
export interface PortfolioAssessmentView extends PortfolioAssessment {
  verdict: PortfolioVerdict | null;
  /** Names of the products in the assessment that the reader can read now. */
  productNames: Record<string, string>;
}

/** One row of `GET /api/portfolio-assessments`. */
export interface PortfolioAssessmentListItem {
  id: string;
  statement: string;
  scope: PortfolioAssessmentScope;
  status: PortfolioAssessmentStatus;
  verdict: PortfolioVerdict | null;
  productCount: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
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
 * #1689 — the rule a run relabelled readable products `restricted` by, as it
 * stored it (`technicalDetail.impact.restrictedRule`, only when its walk
 * stopped at a restricted product):
 *
 * - `walk` — one the run's walk did not reach, but the same walk able to read
 *   every product and repo does.
 * - `adjacent` — an older rule (#1680, #1685): one connected to a product the
 *   walk stopped at. It could mark a product the walk never reaches, and miss
 *   one it does, so a check stored under it is worth running again.
 *
 * Null: no rule, as a run before #1680 stored it (it relabelled every product
 * it did not reach), or an unknown value.
 */
export const PORTFOLIO_RESTRICTED_RULES = ["walk", "adjacent"] as const;
export type PortfolioRestrictedRule = (typeof PORTFOLIO_RESTRICTED_RULES)[number];

export function portfolioRestrictedRule(technicalDetail: unknown): PortfolioRestrictedRule | null {
  const rule = (technicalDetail as { impact?: { restrictedRule?: unknown } } | null | undefined)
    ?.impact?.restrictedRule;
  return PORTFOLIO_RESTRICTED_RULES.find((r) => r === rule) ?? null;
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
 * #1689 — said of the "Not affected" products of a check stored under the
 * older `adjacent` rule, which could miss a product the change reaches.
 */
export const PORTFOLIO_NOT_AFFECTED_OLDER_RULE =
  "This check ran under an older rule for products it could not follow, so a product listed as not affected may still be reached through one that the person who ran it cannot read. Run the check again to find out.";

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
 * The resource a hop crosses (#1618 `ProductResource`) and the tables and
 * columns both ends use (#309), grouped under one heading per resource kind,
 * in a fixed order. The resource itself is left out when the usage
 * classifications already list it.
 */
export function portfolioResourceLists(
  resource: { kind: string; name: string } | null,
  sharedObjects: ReadonlyArray<{
    schemaName: string | null;
    objectName: string;
    objectType: string;
    usageClass: string;
  }>,
): PortfolioResourceList[] {
  const lists = new Map<string, PortfolioResourceList["items"]>();
  const add = (heading: string, item: PortfolioResourceList["items"][number]) => {
    const items = lists.get(heading) ?? [];
    items.push(item);
    lists.set(heading, items);
  };
  if (resource && !sharedObjects.some((o) => o.objectName === resource.name)) {
    const heading = portfolioResourceGroup(resource.kind);
    add(heading, {
      name: resource.name,
      detail: heading === OTHER_RESOURCES ? resource.kind : null,
    });
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
