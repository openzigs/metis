/**
 * Epic #1608 (#1622) — the portfolio gap analysis engine: one requirement
 * evaluated against every repo of every product in scope, answering which
 * product covers it, partly covers it, or that nothing in the portfolio does.
 *
 *   statement + scope
 *     -> products in scope        (`buildProductAccessWhere` / `assertProductAccessible`)
 *     -> readable repos           (`productRepoReadAccess`, #1258)
 *     -> federated retrieval      (`FederatedSearchService`, RRF; one call per product)
 *     -> per-repo verdict         (one model call per repo + the #773 verdict gate)
 *     -> product coverage         (`rollUpProductCoverage`)
 *     -> portfolio verdict        (`rollUpPortfolioVerdict`)
 *     -> persisted                (`createPortfolioAssessment`, #1621)
 *
 * Invariants:
 *
 * - **Access never widens.** "all-accessible" lists only the products the
 *   caller can read. A product named explicitly that the caller cannot read (or
 *   that does not exist: no existence oracle) is `restricted`, carrying nothing
 *   but the id the caller supplied. Inside a readable product only the repos
 *   the caller can read are searched, and the federated search re-intersects
 *   with the caller's projects again (#1052).
 * - **No fabrication.** A repo verdict comes from the model's per-criterion
 *   claims, gated by `gateFindingVerdict`: `implemented` needs a citation, and a
 *   citation can only name an excerpt the repo's own retrieval returned. The
 *   repo on it is stamped here, never taken from the model (#1611).
 * - **Starvation is never a gap.** A repo with no retrieved evidence, a failed
 *   search, a refused or unparseable reply, or no budget left is
 *   `could-not-verify`, and so is never what makes a product `not-covered`.
 * - **Nothing silently omitted.** Every product in scope is in the result.
 * - **Bounded fan-out.** A per-run cost cap, a per-product cost cap and a cap on
 *   products evaluated at once; each product's repos are evaluated one after
 *   another, so at most `concurrency` model calls are in flight. A cap stops
 *   new calls, it does not cancel one in flight, so the spend can pass a cap by
 *   at most the calls already running.
 */
import { z } from "zod";
import {
  PORTFOLIO_ASSESSMENT_SCOPES,
  type AuthPayload,
  type CodeCitation,
  type FindingVerdict,
  type PortfolioAssessmentInput,
  type PortfolioAssessmentScope,
  type PortfolioCoverage,
  type RequirementVerdict,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { buildProvider } from "../ai/providers/factory.js";
import { loadAIConfig } from "../ai/config.js";
import { callJsonLlm } from "../ai/json-llm-client.js";
import { estimateUsageCostUsd } from "../ai/token-tracker.js";
import { getConfigService } from "../config/config-service.js";
import {
  getFederatedSearchService,
  type FederatedHit,
  type FederatedSearchOptions,
  type FederatedSearchResult,
} from "../rag/federated-search-service.js";
import {
  assertProductAccessible,
  buildProductAccessWhere,
  productRepoReadAccess,
} from "../products/product-access.js";
import { gateFindingVerdict, rollUpCriterionVerdicts } from "../analysis/requirement-verdict.js";
import { createPortfolioAssessment } from "./assessment-store.js";
import {
  rollUpPortfolioVerdict,
  rollUpProductCoverage,
  storedPortfolioVerdict,
  type ProductNotCheckedReason,
} from "./gap-rollup.js";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  REPO_VERDICT_SYSTEM_PROMPT,
  buildDecomposePrompt,
  buildRepoVerdictPrompt,
  parseDecomposition,
  parseRepoVerdict,
} from "./gap-prompts.js";

const log = createChildLogger("portfolio-gap");

/** Products a "product" scope may name. */
export const MAX_SCOPE_PRODUCTS = 100;
/** Output tokens one model call may spend. */
const MAX_OUTPUT_TOKENS = 2_000;
/** The prefix of a repository source document's filename: `connector:repo:<id>:src/<path>`. */
const REPO_DOC_PREFIX = "connector:repo:";

// ─── Input ──────────────────────────────────────────────────────────────────

export const portfolioGapInputSchema = z
  .object({
    statement: z.string().trim().min(1).max(8_000),
    /** The requirement's acceptance criteria; decomposed from the statement when empty. */
    criteria: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
    sourceRequirementId: z.string().min(1).max(64).nullable().default(null),
    sourceProjectId: z.string().min(1).max(64).nullable().default(null),
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    /** The products a "product" scope names; ignored for "all-accessible". */
    productIds: z.array(z.string().min(1).max(64)).max(MAX_SCOPE_PRODUCTS).default([]),
  })
  .strict()
  .refine((v) => v.scope !== "product" || v.productIds.length > 0, {
    message: 'A "product" scope names at least one product',
    path: ["productIds"],
  });
export type PortfolioGapInput = z.input<typeof portfolioGapInputSchema>;

// ─── Limits ─────────────────────────────────────────────────────────────────

export interface PortfolioGapLimits {
  /** USD the whole run may spend on model calls. */
  runCostCapUsd: number;
  /** USD the calls for one product may spend. */
  productCostCapUsd: number;
  /** Products evaluated at once (each runs one model call at a time). */
  concurrency: number;
  /** Retrieved excerpts per product. */
  hitsPerProduct: number;
  /** Criteria a statement is split into, at most. */
  maxCriteria: number;
}

export const DEFAULT_PORTFOLIO_GAP_LIMITS: PortfolioGapLimits = {
  runCostCapUsd: 2,
  productCostCapUsd: 0.5,
  concurrency: 4,
  hitsPerProduct: 24,
  maxCriteria: 8,
};

/** The limits from config (`PORTFOLIO_GAP_*`), falling back to the defaults. */
export function readPortfolioGapLimits(): PortfolioGapLimits {
  const cfg = getConfigService();
  const d = DEFAULT_PORTFOLIO_GAP_LIMITS;
  return {
    ...d,
    runCostCapUsd: cfg.getNumber("PORTFOLIO_GAP_RUN_COST_CAP_CENTS", d.runCostCapUsd * 100) / 100,
    productCostCapUsd:
      cfg.getNumber("PORTFOLIO_GAP_PRODUCT_COST_CAP_CENTS", d.productCostCapUsd * 100) / 100,
    concurrency: Math.max(1, cfg.getNumber("PORTFOLIO_GAP_CONCURRENCY", d.concurrency)),
  };
}

// ─── Result ─────────────────────────────────────────────────────────────────

/** Why a repo could not be verified. */
export type RepoNotVerifiedReason =
  "no-evidence-retrieved" | "retrieval-failed" | "budget" | "model-error";

export interface PortfolioRepoResult {
  productId: string;
  repoConnectionId: string;
  label: string;
  verdict: RequirementVerdict;
  /** One gated verdict per criterion. */
  criteria: FindingVerdict[];
  /** Grounded, repo-stamped citations backing the criteria found implemented. */
  citations: CodeCitation[];
  reason: RepoNotVerifiedReason | null;
  costUsd: number;
}

export interface PortfolioProductResult {
  productId: string;
  /** Null for a `restricted` product: the caller learns nothing it did not supply. */
  name: string | null;
  coverage: PortfolioCoverage;
  reason: ProductNotCheckedReason | null;
  repos: PortfolioRepoResult[];
  /** Per criterion, the repos found implementing it. */
  criteriaCoveredBy: string[][];
  inaccessibleRepoCount: number;
  costUsd: number;
}

export interface PortfolioGapResult {
  statement: string;
  criteria: string[];
  scope: PortfolioAssessmentScope;
  productIds: string[];
  products: PortfolioProductResult[];
  verdict: RequirementVerdict;
  summary: string;
  costUsd: number;
}

export interface PortfolioGapDeps {
  provider?: AIProvider;
  search?: (opts: FederatedSearchOptions) => Promise<FederatedSearchResult>;
  limits?: Partial<PortfolioGapLimits>;
  /** USD one model response cost; defaults to the price table (unpriced reads as 0). */
  costOf?: (response: ChatResponse) => number;
  signal?: AbortSignal;
}

// ─── Budget ─────────────────────────────────────────────────────────────────

class Budget {
  private run = 0;
  private readonly byProduct = new Map<string, number>();

  constructor(private readonly limits: PortfolioGapLimits) {}

  /** Whether a new call may start (for a product, or run-wide with `null`). */
  allows(productId: string | null): boolean {
    if (this.run >= this.limits.runCostCapUsd) return false;
    if (productId === null) return true;
    return (this.byProduct.get(productId) ?? 0) < this.limits.productCostCapUsd;
  }

  charge(productId: string | null, usd: number): void {
    const cost = Number.isFinite(usd) && usd > 0 ? usd : 0;
    this.run += cost;
    if (productId !== null) {
      this.byProduct.set(productId, (this.byProduct.get(productId) ?? 0) + cost);
    }
  }

  get total(): number {
    return this.run;
  }
}

function defaultCostOf(response: ChatResponse): number {
  return estimateUsageCostUsd(response.model, response.usage, response.provider) ?? 0;
}

// ─── Scope ──────────────────────────────────────────────────────────────────

interface ScopedProduct {
  id: string;
  name: string | null;
  readable: boolean;
}

interface RepoTarget {
  repoConnectionId: string;
  projectId: string;
  label: string;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function resolveScope(
  user: AuthPayload,
  scope: PortfolioAssessmentScope,
  requested: readonly string[],
): Promise<ScopedProduct[]> {
  if (scope === "all-accessible") {
    const rows = await prisma.product.findMany({
      where: await buildProductAccessWhere(user),
      select: { id: true, name: true },
    });
    return rows.sort(byId).map((r) => ({ id: r.id, name: r.name, readable: true }));
  }
  const out: ScopedProduct[] = [];
  for (const id of [...new Set(requested)]) {
    try {
      await assertProductAccessible(user, id);
      out.push({ id, name: null, readable: true });
    } catch (err) {
      // Unknown and unreadable answer alike: `restricted`, no existence oracle.
      if (err instanceof AppError && err.statusCode === 404) {
        out.push({ id, name: null, readable: false });
      } else {
        throw err;
      }
    }
  }
  const readable = out.filter((p) => p.readable).map((p) => p.id);
  if (readable.length > 0) {
    const names = await prisma.product.findMany({
      where: { id: { in: readable } },
      select: { id: true, name: true },
    });
    const byProduct = new Map(names.map((n) => [n.id, n.name]));
    for (const p of out) if (p.readable) p.name = byProduct.get(p.id) ?? null;
  }
  return out;
}

function repoLabel(rc: { label: string; ownerOrOrg: string | null; repoName: string | null }) {
  if (rc.ownerOrOrg && rc.repoName) return `${rc.ownerOrOrg}/${rc.repoName}`;
  return rc.repoName ?? rc.label;
}

/** Each product's repos the caller can read, and how many it cannot. */
async function loadRepos(
  user: AuthPayload,
  productIds: readonly string[],
): Promise<Map<string, { repos: RepoTarget[]; hidden: number }>> {
  const out = new Map<string, { repos: RepoTarget[]; hidden: number }>();
  for (const id of productIds) out.set(id, { repos: [], hidden: 0 });
  if (productIds.length === 0) return out;
  const canRead = await productRepoReadAccess(user);
  // No `orderBy` and no `take`: Prisma splits a plain `IN` list into statements
  // under SQLite's 999 bound values itself (#1346); sorted in code below.
  const rows = await prisma.productRepo.findMany({
    // A soft-deleted connection is not a repo any more.
    where: { productId: { in: [...productIds] }, repoConnection: { deletedAt: null } },
    select: {
      productId: true,
      repoConnectionId: true,
      repoConnection: {
        select: { projectId: true, label: true, ownerOrOrg: true, repoName: true },
      },
    },
  });
  for (const row of rows) {
    const entry = out.get(row.productId)!;
    if (!canRead(row)) {
      entry.hidden += 1;
      continue;
    }
    entry.repos.push({
      repoConnectionId: row.repoConnectionId,
      projectId: row.repoConnection.projectId,
      label: repoLabel(row.repoConnection),
    });
  }
  for (const entry of out.values()) {
    entry.repos.sort((a, b) => (a.repoConnectionId < b.repoConnectionId ? -1 : 1));
  }
  return out;
}

/**
 * The repo a hit came from: a repository source document names its connection
 * in its filename. Only a hit carrying a repo path (#717) from the project that
 * connection belongs to counts; anything else is not this repo's evidence.
 */
function hitRepo(hit: FederatedHit, repos: ReadonlyMap<string, RepoTarget>): RepoTarget | null {
  if (!hit.path || !hit.filename.startsWith(REPO_DOC_PREFIX)) return null;
  const id = hit.filename.slice(REPO_DOC_PREFIX.length).split(":")[0];
  const repo = repos.get(id);
  return repo && repo.projectId === hit.projectId ? repo : null;
}

function citationFromHit(hit: FederatedHit, repoConnectionId: string): CodeCitation {
  // A repository source chunk records no line span, so the citation is file-level.
  const citation: CodeCitation = {
    filePath: hit.path!,
    startLine: 1,
    endLine: 1,
    repoConnectionId,
  };
  const snippet = hit.text.trim().slice(0, 2_048);
  if (snippet) citation.snippet = snippet;
  return citation;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

interface RunContext {
  user: AuthPayload;
  statement: string;
  criteria: string[];
  query: string;
  provider: AIProvider;
  search: (opts: FederatedSearchOptions) => Promise<FederatedSearchResult>;
  limits: PortfolioGapLimits;
  costOf: (response: ChatResponse) => number;
  budget: Budget;
  signal?: AbortSignal;
}

function notVerified(
  productId: string,
  repo: RepoTarget,
  criteriaCount: number,
  reason: RepoNotVerifiedReason,
  costUsd = 0,
): PortfolioRepoResult {
  return {
    productId,
    repoConnectionId: repo.repoConnectionId,
    label: repo.label,
    verdict: "could-not-verify",
    criteria: Array.from({ length: criteriaCount }, () => "could-not-verify" as const),
    citations: [],
    reason,
    costUsd,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Portfolio gap analysis aborted");
}

async function decompose(
  ctx: Omit<RunContext, "criteria" | "query">,
  given: string[],
): Promise<string[]> {
  // Every supplied criterion is judged (the schema bounds the count): dropping the tail would let
  // a product read as covering a requirement whose remaining criteria were never checked.
  if (given.length > 0) return given;
  if (!ctx.budget.allows(null)) return [ctx.statement];
  try {
    const { parsed } = await callJsonLlm(ctx.provider, {
      systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
      userPrompt: buildDecomposePrompt(ctx.statement, ctx.limits.maxCriteria),
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: ctx.signal,
      onUsage: (r) => ctx.budget.charge(null, ctx.costOf(r)),
    });
    return parseDecomposition(parsed, ctx.limits.maxCriteria) ?? [ctx.statement];
  } catch (err) {
    throwIfAborted(ctx.signal);
    log.warn("Criteria decomposition failed; assessing the statement whole", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [ctx.statement];
  }
}

async function evaluateRepo(
  ctx: RunContext,
  productId: string,
  repo: RepoTarget,
  hits: FederatedHit[],
): Promise<PortfolioRepoResult> {
  let cost = 0;
  let claims: ReturnType<typeof parseRepoVerdict> = null;
  try {
    const { parsed } = await callJsonLlm(ctx.provider, {
      systemPrompt: REPO_VERDICT_SYSTEM_PROMPT,
      userPrompt: buildRepoVerdictPrompt({
        statement: ctx.statement,
        criteria: ctx.criteria,
        repoLabel: repo.label,
        hits: hits.map((h) => ({ path: h.path!, text: h.text })),
      }),
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: ctx.signal,
      onUsage: (r) => {
        const usd = ctx.costOf(r);
        cost += usd;
        ctx.budget.charge(productId, usd);
      },
    });
    claims = parseRepoVerdict(parsed, ctx.criteria.length, hits.length);
  } catch (err) {
    throwIfAborted(ctx.signal);
    log.warn("Repo verdict call failed", {
      productId,
      repoConnectionId: repo.repoConnectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!claims) return notVerified(productId, repo, ctx.criteria.length, "model-error", cost);

  const citations = new Map<string, CodeCitation>();
  const criteria = claims.map((claim, i): FindingVerdict => {
    if (!claim) return "could-not-verify";
    const cited = claim.hitIndexes.map((n) => citationFromHit(hits[n], repo.repoConnectionId));
    // Retrieval for this repo worked (it returned this repo's excerpts), so a
    // gap may be confirmed; `implemented` still needs a grounded citation.
    const gated =
      gateFindingVerdict({
        modelVerdict: claim.verdict,
        groundedCitations: cited,
        finding: { title: ctx.criteria[i], body: claim.reason },
        absenceConfirmable: true,
        retrievalHealthy: true,
      }) ?? "could-not-verify";
    if (gated === "implemented") for (const c of cited) citations.set(c.filePath, c);
    return gated;
  });
  return {
    productId,
    repoConnectionId: repo.repoConnectionId,
    label: repo.label,
    verdict: rollUpCriterionVerdicts(criteria),
    criteria,
    citations: [...citations.values()],
    reason: null,
    costUsd: cost,
  };
}

function restrictedProduct(productId: string, criteriaCount: number): PortfolioProductResult {
  return {
    productId,
    name: null,
    coverage: "restricted",
    reason: null,
    repos: [],
    criteriaCoveredBy: Array.from({ length: criteriaCount }, () => []),
    inaccessibleRepoCount: 0,
    costUsd: 0,
  };
}

async function evaluateProduct(
  ctx: RunContext,
  product: ScopedProduct,
  targets: { repos: RepoTarget[]; hidden: number },
): Promise<PortfolioProductResult> {
  const n = ctx.criteria.length;
  if (!product.readable) return restrictedProduct(product.id, n);

  const repos: PortfolioRepoResult[] = [];
  if (targets.repos.length > 0) {
    const repoById = new Map(targets.repos.map((r) => [r.repoConnectionId, r]));
    const hitsByRepo = new Map<string, FederatedHit[]>();
    let searched: Set<string> | null = null;
    try {
      const result = await ctx.search({
        userId: ctx.user.userId,
        projectIds: [...new Set(targets.repos.map((r) => r.projectId))],
        query: ctx.query,
        k: ctx.limits.hitsPerProduct,
      });
      searched = new Set(result.projectsSearched);
      for (const hit of result.hits) {
        const repo = hitRepo(hit, repoById);
        if (!repo) continue;
        const list = hitsByRepo.get(repo.repoConnectionId) ?? [];
        list.push(hit);
        hitsByRepo.set(repo.repoConnectionId, list);
      }
    } catch (err) {
      throwIfAborted(ctx.signal);
      log.warn("Product retrieval failed", {
        productId: product.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const repo of targets.repos) {
      throwIfAborted(ctx.signal);
      const hits = hitsByRepo.get(repo.repoConnectionId) ?? [];
      if (!searched || !searched.has(repo.projectId)) {
        repos.push(notVerified(product.id, repo, n, "retrieval-failed"));
      } else if (hits.length === 0) {
        repos.push(notVerified(product.id, repo, n, "no-evidence-retrieved"));
      } else if (!ctx.budget.allows(product.id)) {
        repos.push(notVerified(product.id, repo, n, "budget"));
      } else {
        repos.push(await evaluateRepo(ctx, product.id, repo, hits));
      }
    }
  }

  const { coverage, reason } = rollUpProductCoverage(repos, n, targets.hidden);
  return {
    productId: product.id,
    name: product.name,
    coverage,
    reason,
    repos,
    criteriaCoveredBy: Array.from({ length: n }, (_, i) =>
      repos.filter((r) => r.criteria[i] === "implemented").map((r) => r.repoConnectionId),
    ),
    inaccessibleRepoCount: targets.hidden,
    costUsd: repos.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function describeProduct(p: PortfolioProductResult): string {
  // The repos holding the grounded evidence: each met at least one criterion.
  const repos = p.repos.filter((r) => r.criteria.includes("implemented"));
  return `${p.name ?? p.productId} (${repos.map((r) => r.label).join(", ")})`;
}

function portfolioSummary(verdict: RequirementVerdict, products: PortfolioProductResult[]): string {
  const with_ = (c: PortfolioCoverage) => products.filter((p) => p.coverage === c);
  switch (verdict) {
    case "implemented": {
      const partly = with_("partial");
      return [
        `Implemented by ${with_("covers").map(describeProduct).join("; ")}.`,
        ...(partly.length > 0
          ? [`Partly covered by ${partly.map(describeProduct).join("; ")}.`]
          : []),
      ].join(" ");
    }
    case "partial":
      return `Partly covered by ${with_("partial").map(describeProduct).join("; ")}.`;
    case "gap-confirmed":
      return "Nothing in the portfolio covers this.";
    default: {
      const unchecked = with_("not-checked").length;
      const restricted = with_("restricted").length;
      const parts = [
        ...(unchecked > 0 ? [`${unchecked} not checked`] : []),
        ...(restricted > 0 ? [`${restricted} restricted`] : []),
      ];
      return parts.length > 0
        ? `Could not verify across the portfolio: of ${products.length} products, ${parts.join(" and ")}.`
        : "Could not verify: no product was in scope.";
    }
  }
}

function productSummary(p: PortfolioProductResult, criteria: readonly string[]): string {
  switch (p.coverage) {
    case "covers":
      return `Covers it: ${describeProduct(p)}.`;
    case "partial": {
      const uncovered = criteria.flatMap((_, i) =>
        p.criteriaCoveredBy[i].length === 0 ? [i] : [],
      );
      // Only a criterion every repo could be checked against is a gap; one any repo could not
      // verify (budget, model error, no excerpts) is not-checked, never a gap.
      const unchecked = (i: number) => p.repos.some((r) => r.criteria[i] !== "gap-confirmed");
      const names = (idx: number[]) => idx.map((i) => criteria[i]).join("; ");
      const notFound = uncovered.filter((i) => !unchecked(i));
      const notChecked = uncovered.filter(unchecked);
      return [
        `Covers part of it: ${describeProduct(p)}.`,
        ...(notFound.length > 0 ? [`Not found: ${names(notFound)}.`] : []),
        ...(notChecked.length > 0 ? [`Not checked: ${names(notChecked)}.`] : []),
      ].join(" ");
    }
    case "not-covered":
      return "Does not cover it.";
    case "not-checked":
      return `Not checked (${p.reason ?? "could-not-verify"}).`;
    default:
      return "";
  }
}

/**
 * Evaluate a requirement across the portfolio in scope. Does not persist; see
 * {@link runPortfolioGapAnalysis}.
 */
export async function evaluatePortfolioGap(
  user: AuthPayload,
  rawInput: PortfolioGapInput,
  deps: PortfolioGapDeps = {},
): Promise<PortfolioGapResult> {
  const input = portfolioGapInputSchema.parse(rawInput);
  const limits = { ...readPortfolioGapLimits(), ...deps.limits };
  const base = {
    user,
    statement: input.statement,
    provider: deps.provider ?? buildProvider({ config: loadAIConfig() }),
    search:
      deps.search ??
      ((opts: FederatedSearchOptions) => getFederatedSearchService().searchAcrossProjects(opts)),
    limits,
    costOf: deps.costOf ?? defaultCostOf,
    budget: new Budget(limits),
    signal: deps.signal,
  };

  const scoped = await resolveScope(user, input.scope, input.productIds);
  // Nothing readable to check: no model call is worth making.
  const criteria = scoped.some((p) => p.readable)
    ? await decompose(base, input.criteria)
    : input.criteria.length > 0
      ? input.criteria
      : [input.statement];
  const ctx: RunContext = {
    ...base,
    criteria,
    query: [input.statement, ...criteria].join("\n").slice(0, 4_000),
  };
  const repos = await loadRepos(
    user,
    scoped.filter((p) => p.readable).map((p) => p.id),
  );
  const products = await mapWithConcurrency(scoped, limits.concurrency, (p) =>
    evaluateProduct(ctx, p, repos.get(p.id) ?? { repos: [], hidden: 0 }),
  );
  const verdict = rollUpPortfolioVerdict(products.map((p) => p.coverage));
  return {
    statement: input.statement,
    criteria,
    scope: input.scope,
    productIds: scoped.map((p) => p.id),
    products,
    verdict,
    summary: portfolioSummary(verdict, products),
    costUsd: ctx.budget.total,
  };
}

/** The #1621 record of a result. */
export function toAssessmentInput(
  result: PortfolioGapResult,
  meta: { createdById: string; sourceRequirementId: string | null; sourceProjectId: string | null },
): PortfolioAssessmentInput {
  return {
    statement: result.statement,
    sourceRequirementId: meta.sourceRequirementId,
    sourceProjectId: meta.sourceProjectId,
    scope: result.scope,
    productIds: result.productIds,
    status: "completed",
    portfolioVerdict: storedPortfolioVerdict(result.verdict),
    summary: result.summary,
    costUsd: result.costUsd,
    createdById: meta.createdById,
    products: result.products.map((p) => ({
      productId: p.productId,
      coverage: p.coverage,
      baSummary: productSummary(p, result.criteria),
      technicalDetail:
        p.coverage === "restricted"
          ? {}
          : {
              reason: p.reason,
              criteria: result.criteria.map((criterion, i) => ({
                criterion,
                coveredBy: p.criteriaCoveredBy[i],
              })),
              repos: p.repos.map((r) => ({
                repoConnectionId: r.repoConnectionId,
                label: r.label,
                verdict: r.verdict,
                criteria: r.criteria,
                reason: r.reason,
                costUsd: r.costUsd,
              })),
              inaccessibleRepoCount: p.inaccessibleRepoCount,
              costUsd: p.costUsd,
            },
    })),
    repos: result.products.flatMap((p) =>
      p.repos.map((r) => ({
        productId: p.productId,
        repoConnectionId: r.repoConnectionId,
        verdict: r.verdict,
        citations: r.citations,
      })),
    ),
  };
}

/** Evaluate a requirement across the portfolio and persist the assessment (#1621). */
export async function runPortfolioGapAnalysis(
  user: AuthPayload,
  rawInput: PortfolioGapInput,
  deps: PortfolioGapDeps = {},
): Promise<{ assessmentId: string; result: PortfolioGapResult }> {
  const input = portfolioGapInputSchema.parse(rawInput);
  const result = await evaluatePortfolioGap(user, input, deps);
  const assessmentId = await createPortfolioAssessment(
    toAssessmentInput(result, {
      createdById: user.userId,
      sourceRequirementId: input.sourceRequirementId,
      sourceProjectId: input.sourceProjectId,
    }),
  );
  return { assessmentId, result };
}
