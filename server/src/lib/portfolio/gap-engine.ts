/**
 * Epic #1608 (#1622) — the portfolio gap analysis engine: one requirement
 * evaluated against every repo of every product in scope, answering which
 * product covers it, partly covers it, or that nothing in the portfolio does.
 *
 *   statement + scope
 *     -> products in scope        (`buildProductAccessWhere` / `assertProductAccessible`)
 *     -> readable repos           (`productRepoReadAccess`, #1258)
 *     -> federated retrieval      (`FederatedSearchService`, RRF; one call per product,
 *                                  or per project with a per-repo quota, #1763)
 *     -> per-repo verdict         (one model call per repo + the #773 verdict gate)
 *     -> product coverage         (`rollUpProductCoverage`)
 *     -> portfolio verdict        (`rollUpPortfolio`)
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
 * - **Bounded fan-out.** A per-run cost cap, a per-product cost cap, a cap on
 *   model calls (#1657: an unpriced model costs 0, so the cost caps alone never
 *   bind) and a cap on products evaluated at once; each product's repos are
 *   evaluated one after another, so at most `concurrency` model calls are in
 *   flight. A cost cap stops new calls, it does not cancel one in flight, so the
 *   spend can pass it by at most the calls already running; the call cap is
 *   counted as each call starts, so it is never passed.
 * - **A gap needs a search for it** (#1657). A criterion is `gap-confirmed` only
 *   when the query actually sent carried it. #2272 — criteria that do not fit
 *   one query (4,000 characters) or one model call (`maxCriteria`) are checked
 *   in groups ({@link criteriaGroups}), each searched and judged on its own, so
 *   every criterion is searched for: a document's hundredth requirement as much
 *   as its first.
 * - **Nothing cut silently** (#2272). What the run did not check (a criterion
 *   past {@link PORTFOLIO_MAX_REQUIREMENTS}, a repo the budget ran out before)
 *   is listed in `notChecked`, which is stored with the assessment.
 */
import { z } from "zod";
import {
  PORTFOLIO_ASSESSMENT_MAX_PRODUCTS,
  PORTFOLIO_ASSESSMENT_SCOPES,
  PORTFOLIO_MAX_REQUIREMENTS,
  PORTFOLIO_REQUIREMENT_MAX_CHARS,
  PORTFOLIO_STATEMENT_MAX_CHARS,
  portfolioModelErrorText,
  portfolioNamedInProse,
  portfolioNeverAnalysedText,
  portfolioNotInScopeText,
  type AuthPayload,
  type CodeCitation,
  type FindingVerdict,
  type PortfolioAssessmentInput,
  type PortfolioAssessmentProductInput,
  type PortfolioAssessmentScope,
  type PortfolioCoverage,
  type PortfolioNotChecked,
  type RequirementVerdict,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { buildProvider } from "../ai/providers/factory.js";
import { loadAIConfig } from "../ai/config.js";
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
import { MIN_SHARED_TERMS, extractTerms } from "../analysis/retrieval-health.js";
import { canAccessProjectDiscussions } from "../discussions/access.js";
import { createPortfolioAssessment } from "./assessment-store.js";
import type { ProductImpact } from "./impact-engine.js";
import { callJsonLlmRetryingCutOff, resolvePortfolioMaxOutputTokens } from "./output-cap.js";
import {
  hadNothingToCheck,
  rollUpPortfolio,
  rollUpProductCoverage,
  scopeOfChange,
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
import { listedNotChecked } from "./document-requirements.js";

const log = createChildLogger("portfolio-gap");

/**
 * Ids an input may carry. A "product" scope names the products chosen (#2272: one or
 * several; exactly one before, #1622), enforced again by the stored schema (#1647); the
 * list is ignored for "all-accessible". As many as the HTTP contract takes (#1657).
 */
export const MAX_SCOPE_PRODUCTS = PORTFOLIO_ASSESSMENT_MAX_PRODUCTS;
/** Characters of the federated search query. */
export const MAX_QUERY_CHARS = 4_000;
/** #2272 — characters of the statement a grouped query opens with (its first line). */
const GROUP_QUERY_HEAD_CHARS = 200;
/** The prefix of a repository source document's filename: `connector:repo:<id>:src/<path>`. */
const REPO_DOC_PREFIX = "connector:repo:";

// ─── Input ──────────────────────────────────────────────────────────────────

export const portfolioGapInputSchema = z
  .object({
    statement: z.string().trim().min(1).max(PORTFOLIO_STATEMENT_MAX_CHARS),
    /**
     * The requirement's acceptance criteria, or (#2272) a document's
     * requirements, each checked; decomposed from the statement when empty.
     */
    criteria: z
      .array(z.string().trim().min(1).max(PORTFOLIO_REQUIREMENT_MAX_CHARS))
      .max(PORTFOLIO_MAX_REQUIREMENTS)
      .default([]),
    sourceRequirementId: z.string().min(1).max(64).nullable().default(null),
    sourceProjectId: z.string().min(1).max(64).nullable().default(null),
    scope: z.enum(PORTFOLIO_ASSESSMENT_SCOPES),
    /** The products a "product" scope names; ignored for "all-accessible". */
    productIds: z.array(z.string().min(1).max(64)).max(MAX_SCOPE_PRODUCTS).default([]),
  })
  .strict()
  .refine((v) => v.scope !== "product" || v.productIds.length >= 1, {
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
  /**
   * Retrieved excerpts per product. One shared search's `k`; with
   * {@link PortfolioGapLimits.perRepoSearch} on, the total split across its repos (#1763).
   */
  hitsPerProduct: number;
  /** #1763 — with {@link PortfolioGapLimits.perRepoSearch} on, excerpts one repo's verdict sees at most. */
  hitsPerRepo: number;
  /**
   * #1763 — search each of a product's projects on its own and give every repo
   * its share of the hits, so a repo never reads "no evidence" only because a
   * sibling took them all. Off: one shared search per product.
   */
  perRepoSearch: boolean;
  /**
   * Criteria a statement is asked to be split into, at most; and (#2272) the
   * criteria one repo verdict call judges at once ({@link criteriaGroups}).
   */
  maxCriteria: number;
  /** Model calls the whole run may make (#1657). */
  maxModelCalls: number;
}

export const DEFAULT_PORTFOLIO_GAP_LIMITS: PortfolioGapLimits = {
  runCostCapUsd: 2,
  productCostCapUsd: 0.5,
  concurrency: 4,
  hitsPerProduct: 24,
  hitsPerRepo: 12,
  perRepoSearch: false,
  maxCriteria: 8,
  maxModelCalls: 250,
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
    maxModelCalls: Math.max(0, cfg.getNumber("PORTFOLIO_GAP_MAX_MODEL_CALLS", d.maxModelCalls)),
    hitsPerProduct: Math.max(1, cfg.getNumber("PORTFOLIO_GAP_HITS_PER_PRODUCT", d.hitsPerProduct)),
    hitsPerRepo: Math.max(1, cfg.getNumber("PORTFOLIO_GAP_HITS_PER_REPO", d.hitsPerRepo)),
    perRepoSearch: cfg.getBool("PORTFOLIO_GAP_PER_REPO_SEARCH", d.perRepoSearch),
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
  /**
   * #1963 — the products the verdict leaves out as not in scope of the change
   * (`notInScopeOfChange`); set once the impact is known (`scopedToChange`).
   */
  notInScope?: string[];
  /**
   * #1963 — the products not checked that read `none` but were never analysed
   * (`scopeOfChange`): kept in the verdict, and named after it.
   */
  neverAnalysed?: string[];
  /**
   * #2272 — what the run did not check: criteria the model split the statement
   * into past {@link PORTFOLIO_MAX_REQUIREMENTS}, and criteria some repos were
   * not checked for because the budget ran out.
   */
  notChecked: PortfolioNotChecked[];
}

export interface PortfolioGapDeps {
  provider?: AIProvider;
  search?: (opts: FederatedSearchOptions) => Promise<FederatedSearchResult>;
  limits?: Partial<PortfolioGapLimits>;
  /** USD one model response cost; defaults to the price table (unpriced reads as 0). */
  costOf?: (response: ChatResponse) => number;
  signal?: AbortSignal;
  /** Called as each product in scope finishes (#1625 job progress). */
  onProgress?: (progress: { done: number; total: number }) => void;
}

// ─── Budget ─────────────────────────────────────────────────────────────────

class Budget {
  private run = 0;
  private calls = 0;
  private readonly byProduct = new Map<string, number>();

  constructor(private readonly limits: PortfolioGapLimits) {}

  /** Whether a new call may start (for a product, or run-wide with `null`). */
  allows(productId: string | null): boolean {
    if (this.calls >= this.limits.maxModelCalls) return false;
    if (this.run >= this.limits.runCostCapUsd) return false;
    if (productId === null) return true;
    return (this.byProduct.get(productId) ?? 0) < this.limits.productCostCapUsd;
  }

  /** Count a call as it starts, so the call cap is never passed. */
  startCall(): void {
    this.calls += 1;
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

/** #1726 — whether a cut-off reply may be retried: the budget allows a call, which is counted. */
function retryAllowed(budget: Budget, productId: string | null): boolean {
  if (!budget.allows(productId)) return false;
  budget.startCall();
  return true;
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

/**
 * #2272 — criteria searched for and judged together: one federated search per
 * product and one model call per repo. `start` is the index of its first
 * criterion in the run's criteria.
 */
export interface CriteriaGroup {
  start: number;
  criteria: string[];
  query: string;
  /** Per criterion of the group, whether its query searched for it (#1657). */
  searched: boolean[];
}

/**
 * #2272 — the run's criteria in groups. A statement and criteria that fit one
 * query and one call are one group, its query the statement and every
 * criterion, as before. Otherwise each group holds at most `perCall` criteria
 * and its query is the statement's first line and the group's criteria whole,
 * within {@link MAX_QUERY_CHARS}: every criterion is searched for, where one
 * query cut to that length left a long requirement's later criteria unsearched
 * and so never confirmable as a gap (#1657).
 */
export function criteriaGroups(
  statement: string,
  criteria: readonly string[],
  perCall: number,
): CriteriaGroup[] {
  const group = (start: number, list: string[], query: string): CriteriaGroup => ({
    start,
    criteria: list,
    query,
    searched: list.map((c) => querySearchedFor(query, c)),
  });
  const whole = [statement, ...criteria].join("\n");
  const size = Math.max(1, perCall);
  if (criteria.length <= size && whole.length <= MAX_QUERY_CHARS) {
    return [group(0, [...criteria], whole)];
  }
  const head = statement.split("\n", 1)[0].trim().slice(0, GROUP_QUERY_HEAD_CHARS);
  const queryOf = (list: readonly string[]) =>
    [head, ...list].filter(Boolean).join("\n").slice(0, MAX_QUERY_CHARS);
  const out: CriteriaGroup[] = [];
  let current: string[] = [];
  let start = 0;
  criteria.forEach((c, i) => {
    const longer = [head, ...current, c].join("\n").length > MAX_QUERY_CHARS;
    if (current.length > 0 && (current.length >= size || longer)) {
      out.push(group(start, current, queryOf(current)));
      current = [];
      start = i;
    }
    current.push(c);
  });
  if (current.length > 0) out.push(group(start, current, queryOf(current)));
  return out;
}

interface RunContext {
  user: AuthPayload;
  statement: string;
  criteria: string[];
  /** #2272 — the criteria in the groups each search and repo call takes. */
  groups: CriteriaGroup[];
  provider: AIProvider;
  search: (opts: FederatedSearchOptions) => Promise<FederatedSearchResult>;
  limits: PortfolioGapLimits;
  costOf: (response: ChatResponse) => number;
  budget: Budget;
  signal?: AbortSignal;
  /** #1726 — the OUTPUT cap of each model call (`resolvePortfolioMaxOutputTokens`). */
  maxTokens: number;
  /**
   * #1726 — each repo's model verdict, by connection id and (#2272) criteria
   * group: a repo in several products is assessed once per run, and every
   * product holding it reuses it.
   */
  repoVerdicts: Map<string, Promise<PortfolioRepoResult>>;
  /** #2272 — per criteria group, the repos not checked for it because the budget ran out. */
  budgetSkipped: Map<number, Set<string>>;
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

/**
 * The criteria to judge. #2272 — every one the model split the statement into,
 * up to {@link PORTFOLIO_MAX_REQUIREMENTS} (it is asked for `maxCriteria`; more
 * are checked in groups, not dropped); any past that are returned as
 * `overflow`, listed not checked.
 */
async function decompose(
  ctx: Omit<RunContext, "criteria" | "groups" | "repoVerdicts" | "budgetSkipped">,
  given: string[],
): Promise<{ criteria: string[]; overflow: string[] }> {
  const capped = (all: string[]) => ({
    criteria: all.slice(0, PORTFOLIO_MAX_REQUIREMENTS),
    overflow: all.slice(PORTFOLIO_MAX_REQUIREMENTS),
  });
  // Every supplied criterion is judged (the schema bounds the count): dropping the tail would let
  // a product read as covering a requirement whose remaining criteria were never checked.
  if (given.length > 0) return capped(given);
  if (!ctx.budget.allows(null)) return capped([ctx.statement]);
  try {
    ctx.budget.startCall();
    const { parsed } = await callJsonLlmRetryingCutOff(
      ctx.provider,
      {
        systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
        userPrompt: buildDecomposePrompt(ctx.statement, ctx.limits.maxCriteria),
        maxTokens: ctx.maxTokens,
        signal: ctx.signal,
        onUsage: (r) => ctx.budget.charge(null, ctx.costOf(r)),
      },
      () => retryAllowed(ctx.budget, null),
    );
    return capped(parseDecomposition(parsed, Number.POSITIVE_INFINITY) ?? [ctx.statement]);
  } catch (err) {
    throwIfAborted(ctx.signal);
    log.warn("Criteria decomposition failed; assessing the statement whole", {
      error: err instanceof Error ? err.message : String(err),
    });
    return capped([ctx.statement]);
  }
}

/** One repo's verdict on one criteria group's criteria (#2272). */
async function evaluateRepo(
  ctx: RunContext,
  group: CriteriaGroup,
  productId: string,
  repo: RepoTarget,
  hits: FederatedHit[],
): Promise<PortfolioRepoResult> {
  let cost = 0;
  let claims: ReturnType<typeof parseRepoVerdict> = null;
  try {
    ctx.budget.startCall();
    const { parsed } = await callJsonLlmRetryingCutOff(
      ctx.provider,
      {
        systemPrompt: REPO_VERDICT_SYSTEM_PROMPT,
        userPrompt: buildRepoVerdictPrompt({
          statement: ctx.statement,
          criteria: group.criteria,
          repoLabel: repo.label,
          hits: hits.map((h) => ({ path: h.path!, text: h.text })),
        }),
        maxTokens: ctx.maxTokens,
        signal: ctx.signal,
        onUsage: (r) => {
          const usd = ctx.costOf(r);
          cost += usd;
          ctx.budget.charge(productId, usd);
        },
      },
      () => retryAllowed(ctx.budget, productId),
    );
    claims = parseRepoVerdict(parsed, group.criteria.length, hits.length);
  } catch (err) {
    throwIfAborted(ctx.signal);
    log.warn("Repo verdict call failed", {
      productId,
      repoConnectionId: repo.repoConnectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!claims) return notVerified(productId, repo, group.criteria.length, "model-error", cost);

  const citations = new Map<string, CodeCitation>();
  const criteria = claims.map((claim, i): FindingVerdict => {
    if (!claim) return "could-not-verify";
    const cited = claim.hitIndexes.map((n) => citationFromHit(hits[n], repo.repoConnectionId));
    // Retrieval for this repo worked (it returned this repo's excerpts), so a
    // gap may be confirmed when the query searched for this criterion (#1657);
    // `implemented` still needs a grounded citation.
    const gated =
      gateFindingVerdict({
        modelVerdict: claim.verdict,
        groundedCitations: cited,
        finding: { title: group.criteria[i], body: claim.reason },
        absenceConfirmable: group.searched[i] === true,
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

/** A product's retrieved excerpts, by repo, and the projects whose search succeeded. */
interface Retrieval {
  hitsByRepo: Map<string, FederatedHit[]>;
  searched: Set<string>;
}

/** Each hit that is one of `repos`' evidence, filed under its repo, at most `quota` per repo. */
function fileHits(
  hits: readonly FederatedHit[],
  repos: ReadonlyMap<string, RepoTarget>,
  into: Map<string, FederatedHit[]>,
  quota = Infinity,
): void {
  for (const hit of hits) {
    const repo = hitRepo(hit, repos);
    if (!repo) continue;
    const list = into.get(repo.repoConnectionId) ?? [];
    if (list.length >= quota) continue;
    list.push(hit);
    into.set(repo.repoConnectionId, list);
  }
}

/** One search across all of a product's projects, split by repo afterwards. */
async function retrieveShared(
  ctx: RunContext,
  group: CriteriaGroup,
  productId: string,
  repos: readonly RepoTarget[],
): Promise<Retrieval> {
  const hitsByRepo = new Map<string, FederatedHit[]>();
  try {
    const result = await ctx.search({
      userId: ctx.user.userId,
      projectIds: [...new Set(repos.map((r) => r.projectId))],
      query: group.query,
      k: ctx.limits.hitsPerProduct,
      // #2238 — every project's evidence decides its repos' coverage, so none
      // is left out for being less relevant than another: the rank-fusion
      // result this engine was built on.
      relevanceFloor: 0,
    });
    fileHits(result.hits, new Map(repos.map((r) => [r.repoConnectionId, r])), hitsByRepo);
    return { hitsByRepo, searched: new Set(result.projectsSearched) };
  } catch (err) {
    throwIfAborted(ctx.signal);
    log.warn("Product retrieval failed", {
      productId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hitsByRepo, searched: new Set() };
  }
}

/** #1763 — project searches {@link retrievePerRepo} runs at once for one product. */
const PER_REPO_SEARCH_CONCURRENCY = 4;
/**
 * #1763 — a project's search asks for this many candidates per excerpt it may
 * keep: the repos in one project, and the project's own documents, share one
 * ranked list, so a repo's share sits further down it than its quota.
 */
const PER_REPO_OVERFETCH = 2;

/**
 * #1763 — the excerpts each of `repoCount` repos may keep: an even split of
 * `hitsPerProduct`, at most `hitsPerRepo`, and never less than one, so the
 * product's total is at most the larger of `hitsPerProduct` and its repo count.
 */
export function perRepoHitQuota(
  limits: Pick<PortfolioGapLimits, "hitsPerProduct" | "hitsPerRepo">,
  repoCount: number,
): number {
  const share = Math.floor(limits.hitsPerProduct / Math.max(1, repoCount));
  return Math.max(1, Math.min(limits.hitsPerRepo, share));
}

/**
 * #1763 — one search per project the product's repos live in, each repo
 * keeping at most its {@link perRepoHitQuota}: a repo whose sibling dominates a
 * shared ranking still gets its own excerpts. A project whose search fails
 * leaves only its own repos `retrieval-failed`.
 */
async function retrievePerRepo(
  ctx: RunContext,
  group: CriteriaGroup,
  productId: string,
  repos: readonly RepoTarget[],
): Promise<Retrieval> {
  const quota = perRepoHitQuota(ctx.limits, repos.length);
  const repoById = new Map(repos.map((r) => [r.repoConnectionId, r]));
  const heldBy = new Map<string, number>();
  for (const r of repos) heldBy.set(r.projectId, (heldBy.get(r.projectId) ?? 0) + 1);
  const hitsByRepo = new Map<string, FederatedHit[]>();
  const searched = new Set<string>();
  await mapWithConcurrency([...heldBy], PER_REPO_SEARCH_CONCURRENCY, async ([projectId, held]) => {
    // An aborted run starts no further search; the product's repo loop rethrows the abort.
    throwIfAborted(ctx.signal);
    let result: FederatedSearchResult;
    try {
      result = await ctx.search({
        userId: ctx.user.userId,
        projectIds: [projectId],
        query: group.query,
        k: quota * held * PER_REPO_OVERFETCH,
      });
    } catch (err) {
      log.warn("Project retrieval failed", {
        productId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!result.projectsSearched.includes(projectId)) return;
    searched.add(projectId);
    fileHits(result.hits, repoById, hitsByRepo, quota);
  });
  return { hitsByRepo, searched };
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

/**
 * #2272 — one repo's verdicts on each criteria group, as one result over every
 * criterion: the groups' criteria in order, their citations once each, their
 * cost summed. A group the model judged leaves no reason; the first group's
 * reason it could not be verified is kept otherwise, a failed model call before
 * any other (it is named to the reader, #1726). One group is returned as it is.
 */
export function mergeRepoGroups(parts: readonly PortfolioRepoResult[]): PortfolioRepoResult {
  if (parts.length === 1) return parts[0];
  const criteria = parts.flatMap((p) => p.criteria);
  const citations = new Map<string, CodeCitation>();
  for (const p of parts) for (const c of p.citations) citations.set(c.filePath, c);
  const reasons = parts.map((p) => p.reason).filter((r): r is RepoNotVerifiedReason => r !== null);
  return {
    productId: parts[0].productId,
    repoConnectionId: parts[0].repoConnectionId,
    label: parts[0].label,
    verdict: rollUpCriterionVerdicts(criteria),
    criteria,
    citations: [...citations.values()],
    reason: reasons.includes("model-error") ? "model-error" : (reasons[0] ?? null),
    costUsd: parts.reduce((sum, p) => sum + p.costUsd, 0),
  };
}

/** One repo's verdict on one criteria group, from the retrieval that group's query made. */
async function evaluateRepoGroup(
  ctx: RunContext,
  group: CriteriaGroup,
  groupIndex: number,
  productId: string,
  repo: RepoTarget,
  retrieval: Retrieval,
): Promise<PortfolioRepoResult> {
  const n = group.criteria.length;
  const key = `${repo.repoConnectionId}\u0000${groupIndex}`;
  const hits = retrieval.hitsByRepo.get(repo.repoConnectionId) ?? [];
  if (ctx.repoVerdicts.has(key)) {
    // #1726 — assessed already for another product in this run: reused (checked before this
    // product's own search result, so the same repo does not read "no evidence" here and a
    // verdict there), and its cost is not counted twice.
    const assessed = await ctx.repoVerdicts.get(key)!;
    return { ...assessed, productId, costUsd: 0 };
  }
  if (!retrieval.searched.has(repo.projectId)) {
    return notVerified(productId, repo, n, "retrieval-failed");
  }
  if (hits.length === 0) return notVerified(productId, repo, n, "no-evidence-retrieved");
  if (!ctx.budget.allows(productId)) {
    // #2272 — listed not checked: this repo was never judged on these criteria.
    const skipped = ctx.budgetSkipped.get(groupIndex) ?? new Set<string>();
    skipped.add(repo.repoConnectionId);
    ctx.budgetSkipped.set(groupIndex, skipped);
    return notVerified(productId, repo, n, "budget");
  }
  const verdict = evaluateRepo(ctx, group, productId, repo, hits);
  ctx.repoVerdicts.set(key, verdict);
  return verdict;
}

async function evaluateProduct(
  ctx: RunContext,
  product: ScopedProduct,
  targets: { repos: RepoTarget[]; hidden: number },
): Promise<PortfolioProductResult> {
  const n = ctx.criteria.length;
  if (!product.readable) return restrictedProduct(product.id, n);

  // #2272 — per repo, its verdict on each criteria group, in group order.
  const parts: PortfolioRepoResult[][] = targets.repos.map(() => []);
  if (targets.repos.length > 0) {
    for (const [gi, group] of ctx.groups.entries()) {
      throwIfAborted(ctx.signal);
      const retrieval = ctx.limits.perRepoSearch
        ? await retrievePerRepo(ctx, group, product.id, targets.repos)
        : await retrieveShared(ctx, group, product.id, targets.repos);
      for (const [k, repo] of targets.repos.entries()) {
        throwIfAborted(ctx.signal);
        parts[k].push(await evaluateRepoGroup(ctx, group, gi, product.id, repo, retrieval));
      }
    }
  }
  const repos = parts.map(mergeRepoGroups);

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

/**
 * `fn` over `items`, `limit` at a time. Once one call rejects no new item is
 * started (#1657): the run has failed, so further calls are spend for nothing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function describeProduct(p: PortfolioProductResult): string {
  // The repos holding the grounded evidence: each met at least one criterion.
  const repos = p.repos.filter((r) => r.criteria.includes("implemented"));
  // #1689 — never a raw id in analyst prose.
  return `${p.name ?? "a product"} (${repos.map((r) => r.label).join(", ")})`;
}

/** #1726 — the labels of the repos whose model call failed, each once. */
function failedRepoLabels(products: readonly Pick<PortfolioProductResult, "repos">[]): string[] {
  return [
    ...new Set(
      products.flatMap((p) =>
        p.repos.filter((r) => r.reason === "model-error").map((r) => r.label),
      ),
    ),
  ];
}

/**
 * The BA summary of a portfolio verdict over its products. #1726 — a repo whose
 * model call failed is named, with what to do: the answer leaves it out.
 */
export function portfolioSummary(
  verdict: RequirementVerdict,
  products: readonly PortfolioProductResult[],
  scope: ChangeScope = {},
): string {
  const failed = failedRepoLabels(products);
  const answer = verdictSummary(verdict, products, scope);
  return failed.length > 0
    ? `${answer} ${portfolioModelErrorText(failed, { leftOut: true })}`
    : answer;
}

/** #1963 — how the change scoped a verdict (`scopeOfChange`). */
export interface ChangeScope {
  /** Left out of the verdict: not checked, and not connected to what changes. */
  notInScope?: ReadonlySet<string>;
  /** Kept in: not checked, and never analysed, so its reach is not known. */
  neverAnalysed?: ReadonlySet<string>;
}

function verdictSummary(
  verdict: RequirementVerdict,
  allProducts: readonly PortfolioProductResult[],
  { notInScope = new Set(), neverAnalysed = new Set() }: ChangeScope,
): string {
  // #1963 — the verdict was rolled up without these; they are named after it.
  const outside = allProducts.filter((p) => notInScope.has(p.productId));
  const products = allProducts.filter((p) => !notInScope.has(p.productId));
  const outsideSentence =
    outside.length > 0 ? [portfolioNotInScopeText(outside.map((p) => p.name))] : [];
  // #1963 — kept in the verdict: why they were not left out with the others.
  const unanalysed = products.filter((p) => neverAnalysed.has(p.productId));
  const unanalysedSentence =
    unanalysed.length > 0 ? [portfolioNeverAnalysedText(unanalysed.map((p) => p.name))] : [];
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
    case "gap-confirmed": {
      // #1677 — left out of the verdict, but still named.
      const empty = products.filter(hadNothingToCheck);
      return [
        // #1963 — a gap over the products in scope, not the whole portfolio.
        outside.length > 0
          ? "Nothing checked covers this."
          : "Nothing in the portfolio covers this.",
        ...outsideSentence,
        ...(empty.length > 0
          ? [
              // #1685 — never a raw id in analyst prose; #1689 — nor "a product" twice.
              `${portfolioNamedInProse(
                empty.map((p) => p.name),
                { sentenceStart: true },
              )} ${empty.length === 1 ? "has" : "have"} no repositories to check.`,
            ]
          : []),
      ].join(" ");
    }
    default: {
      const unchecked = with_("not-checked").length;
      const restricted = with_("restricted").length;
      const parts = [
        ...(unchecked > 0 ? [`${unchecked} not checked`] : []),
        ...(restricted > 0 ? [`${restricted} restricted`] : []),
      ];
      return [
        parts.length > 0
          ? `Could not verify across the portfolio: of ${products.length} products${
              outside.length > 0 ? " in scope" : ""
            }, ${parts.join(" and ")}.`
          : "Could not verify: no product was in scope.",
        ...unanalysedSentence,
        ...outsideSentence,
      ].join(" ");
    }
  }
}

/** The BA summary of one product's coverage. */
export function productSummary(p: PortfolioProductResult, criteria: readonly string[]): string {
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
    case "not-checked": {
      // #1726 — a failed model call says so, and a gap another repo confirmed is kept.
      const failed = failedRepoLabels([p]);
      if (failed.length === 0) return `Not checked (${p.reason ?? "could-not-verify"}).`;
      const gaps = p.repos.filter((r) => r.verdict === "gap-confirmed").map((r) => r.label);
      return [
        `Not checked. ${portfolioModelErrorText(failed)}`,
        ...(gaps.length > 0
          ? [`${portfolioNamedInProse(gaps)} ${gaps.length === 1 ? "does" : "do"} not cover it.`]
          : []),
      ].join(" ");
    }
    default:
      return "";
  }
}

/**
 * #1657 — whether `query` searched for `criterion`: it carries the criterion
 * whole, or at least {@link MIN_SHARED_TERMS} of its significant terms. The
 * query is cut to {@link MAX_QUERY_CHARS}, so a long requirement's later
 * criteria can be missing from it, and an absence nobody searched for is not a
 * confirmed gap.
 */
export function querySearchedFor(query: string, criterion: string): boolean {
  if (query.includes(criterion)) return true;
  const queryTerms = extractTerms(query);
  let shared = 0;
  for (const term of extractTerms(criterion)) if (queryTerms.has(term)) shared += 1;
  return shared >= MIN_SHARED_TERMS;
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
  return evaluateParsed(user, portfolioGapInputSchema.parse(rawInput), deps);
}

async function evaluateParsed(
  user: AuthPayload,
  input: z.output<typeof portfolioGapInputSchema>,
  deps: PortfolioGapDeps,
): Promise<PortfolioGapResult> {
  const limits = { ...readPortfolioGapLimits(), ...deps.limits };
  const provider = deps.provider ?? buildProvider({ config: loadAIConfig() });
  const base = {
    user,
    statement: input.statement,
    provider,
    maxTokens: resolvePortfolioMaxOutputTokens(provider),
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
  const { criteria, overflow } = scoped.some((p) => p.readable)
    ? await decompose(base, input.criteria)
    : { criteria: input.criteria.length > 0 ? input.criteria : [input.statement], overflow: [] };
  const ctx: RunContext = {
    ...base,
    criteria,
    groups: criteriaGroups(input.statement, criteria, limits.maxCriteria),
    repoVerdicts: new Map(),
    budgetSkipped: new Map(),
  };
  const repos = await loadRepos(
    user,
    scoped.filter((p) => p.readable).map((p) => p.id),
  );
  let done = 0;
  const products = await mapWithConcurrency(scoped, limits.concurrency, async (p) => {
    const result = await evaluateProduct(ctx, p, repos.get(p.id) ?? { repos: [], hidden: 0 });
    done += 1;
    deps.onProgress?.({ done, total: scoped.length });
    return result;
  });
  const verdict = rollUpPortfolio(products);
  return {
    statement: input.statement,
    criteria,
    scope: input.scope,
    productIds: scoped.map((p) => p.id),
    products,
    verdict,
    summary: portfolioSummary(verdict, products),
    costUsd: ctx.budget.total,
    notChecked: notCheckedOf(ctx, overflow),
  };
}

/**
 * #2272 — what the run did not check: each criterion past the cap, and each
 * criterion some repos were not judged on because the budget ran out (with how
 * many repos).
 */
function notCheckedOf(ctx: RunContext, overflow: readonly string[]): PortfolioNotChecked[] {
  const out: PortfolioNotChecked[] = [];
  for (const [gi, group] of ctx.groups.entries()) {
    const skipped = ctx.budgetSkipped.get(gi)?.size ?? 0;
    if (skipped === 0) continue;
    for (const c of group.criteria) {
      out.push({ text: clipText(c), reason: "budget", count: skipped });
    }
  }
  // A statement the model split into more than the cap: listed up to a bound, the rest counted,
  // so a huge reply cannot overrun the stored list's cap and fail the write.
  out.push(
    ...listedNotChecked(overflow.map(clipText), "over-limit", (n) => `${n} more requirements`),
  );
  return out;
}

/** A not-checked entry's text: whole when it fits, else its opening and an ellipsis. */
export function clipText(text: string): string {
  return text.length <= PORTFOLIO_REQUIREMENT_MAX_CHARS
    ? text
    : `${text.slice(0, PORTFOLIO_REQUIREMENT_MAX_CHARS - 1)}…`;
}

/**
 * #1963 — the gap result with its verdict and summary rolled up over the
 * products in scope of the change: a product not checked that is not connected
 * to any product the change touches (no path of edges, either way, at any
 * depth: `connectedToChange`), and whose edges were detected, is left out of
 * the verdict and named after it (`scopeOfChange`). An `all-accessible` check reaches every
 * product its starter can see, so without this one unrelated product turns a
 * gap the changed products all confirm into "could not verify". One never
 * analysed stays in, named as such: its `none` says nothing. With no product
 * that changes, nothing is known to be unrelated, and the result is as it was.
 */
export function scopedToChange(
  gap: PortfolioGapResult,
  impact: {
    products: readonly Pick<
      ProductImpact,
      "productId" | "restricted" | "impactKind" | "edgesDetected" | "connectedToChange"
    >[];
  },
): PortfolioGapResult {
  // A restricted product may be reached through what its reader cannot see.
  const scope = scopeOfChange(
    gap.products,
    impact.products.filter((p) => !p.restricted),
  );
  if (scope.notInScope.size === 0 && scope.neverAnalysed.size === 0) return gap;
  const verdict = rollUpPortfolio(gap.products, scope.notInScope);
  return {
    ...gap,
    verdict,
    summary: portfolioSummary(verdict, gap.products, scope),
    notInScope: [...scope.notInScope].sort(),
    neverAnalysed: [...scope.neverAnalysed].sort(),
  };
}

/** One product's #1621 record: its coverage, BA summary and technical detail. */
export function toProductRecord(
  p: PortfolioProductResult,
  criteria: readonly string[],
): PortfolioAssessmentProductInput {
  return {
    productId: p.productId,
    coverage: p.coverage,
    baSummary: productSummary(p, criteria),
    technicalDetail:
      p.coverage === "restricted"
        ? {}
        : {
            reason: p.reason,
            criteria: criteria.map((criterion, i) => ({
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
    products: result.products.map((p) => toProductRecord(p, result.criteria)),
    // #2272 — what the run did not check, stored with what it did.
    notChecked: result.notChecked,
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

/**
 * #1657 — the requirement `requirementId`, or 404 unless it is live (not
 * soft-deleted), in `projectId` when one is given, and in a project `user` can
 * read: an assessment copies a requirement's text, and records it as its
 * source, only for a starter who can read it. Unknown, deleted, elsewhere and
 * unreadable answer alike (no existence oracle).
 */
export async function loadReadableSourceRequirement(
  user: AuthPayload,
  requirementId: string,
  projectId?: string | null,
): Promise<{
  id: string;
  projectId: string;
  title: string;
  body: string;
  acceptanceCriteria: string | null;
  /** #2345 — its review status, so a check before approval is labelled so. */
  reviewStatus?: string | null;
}> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, deletedAt: null, ...(projectId ? { projectId } : {}) },
    select: {
      id: true,
      projectId: true,
      title: true,
      body: true,
      acceptanceCriteria: true,
      reviewStatus: true,
    },
  });
  if (
    !requirement ||
    !(await canAccessProjectDiscussions(
      { id: user.userId, role: user.role },
      requirement.projectId,
    ))
  ) {
    throw new AppError(404, "NOT_FOUND", "Requirement not found");
  }
  return requirement;
}

/** Evaluate a requirement across the portfolio and persist the assessment (#1621). */
export async function runPortfolioGapAnalysis(
  user: AuthPayload,
  rawInput: PortfolioGapInput,
  deps: PortfolioGapDeps = {},
): Promise<{ assessmentId: string; result: PortfolioGapResult }> {
  const input = portfolioGapInputSchema.parse(rawInput);
  // #1657 — a source is recorded only for a starter who can read it, and a
  // project only with the requirement it holds.
  if (input.sourceRequirementId) {
    await loadReadableSourceRequirement(user, input.sourceRequirementId, input.sourceProjectId);
  } else if (input.sourceProjectId) {
    throw new AppError(400, "VALIDATION_ERROR", "sourceProjectId needs a sourceRequirementId");
  }
  const result = await evaluateParsed(user, input, deps);
  const assessmentId = await createPortfolioAssessment(
    toAssessmentInput(result, {
      createdById: user.userId,
      sourceRequirementId: input.sourceRequirementId,
      sourceProjectId: input.sourceProjectId,
    }),
  );
  return { assessmentId, result };
}
