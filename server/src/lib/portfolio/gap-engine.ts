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
 *   when the query actually sent carried it: the query is cut to 4,000
 *   characters, so a long requirement's later criteria may never be searched for.
 */
import { z } from "zod";
import {
  PORTFOLIO_ASSESSMENT_SCOPES,
  portfolioModelErrorText,
  portfolioNamedInProse,
  type AuthPayload,
  type CodeCitation,
  type FindingVerdict,
  type PortfolioAssessmentInput,
  type PortfolioAssessmentProductInput,
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
  notInScopeOfChange,
  rollUpPortfolio,
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

/**
 * Ids an input may carry. A "product" scope names exactly one (#1622's "one product or
 * all products I can access", enforced again by the stored schema, #1647); the list is
 * ignored for "all-accessible". One, as the HTTP contract (#1657).
 */
export const MAX_SCOPE_PRODUCTS = 1;
/** Characters of the federated search query. */
const MAX_QUERY_CHARS = 4_000;
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
    /** The one product a "product" scope names; ignored for "all-accessible". */
    productIds: z.array(z.string().min(1).max(64)).max(MAX_SCOPE_PRODUCTS).default([]),
  })
  .strict()
  .refine((v) => v.scope !== "product" || v.productIds.length === 1, {
    message: 'A "product" scope names exactly one product',
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
  /** Criteria a statement is split into, at most. */
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
  /** Per criterion, whether the query sent searched for it (#1657). */
  searched: boolean[];
  signal?: AbortSignal;
  /** #1726 — the OUTPUT cap of each model call (`resolvePortfolioMaxOutputTokens`). */
  maxTokens: number;
  /**
   * #1726 — each repo's model verdict, by connection id: a repo in several
   * products is assessed once per run, and every product holding it reuses it.
   */
  repoVerdicts: Map<string, Promise<PortfolioRepoResult>>;
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
  ctx: Omit<RunContext, "criteria" | "query" | "searched" | "repoVerdicts">,
  given: string[],
): Promise<string[]> {
  // Every supplied criterion is judged (the schema bounds the count): dropping the tail would let
  // a product read as covering a requirement whose remaining criteria were never checked.
  if (given.length > 0) return given;
  if (!ctx.budget.allows(null)) return [ctx.statement];
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
    ctx.budget.startCall();
    const { parsed } = await callJsonLlmRetryingCutOff(
      ctx.provider,
      {
        systemPrompt: REPO_VERDICT_SYSTEM_PROMPT,
        userPrompt: buildRepoVerdictPrompt({
          statement: ctx.statement,
          criteria: ctx.criteria,
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
    // gap may be confirmed when the query searched for this criterion (#1657);
    // `implemented` still needs a grounded citation.
    const gated =
      gateFindingVerdict({
        modelVerdict: claim.verdict,
        groundedCitations: cited,
        finding: { title: ctx.criteria[i], body: claim.reason },
        absenceConfirmable: ctx.searched[i] === true,
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
  productId: string,
  repos: readonly RepoTarget[],
): Promise<Retrieval> {
  const hitsByRepo = new Map<string, FederatedHit[]>();
  try {
    const result = await ctx.search({
      userId: ctx.user.userId,
      projectIds: [...new Set(repos.map((r) => r.projectId))],
      query: ctx.query,
      k: ctx.limits.hitsPerProduct,
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
        query: ctx.query,
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

async function evaluateProduct(
  ctx: RunContext,
  product: ScopedProduct,
  targets: { repos: RepoTarget[]; hidden: number },
): Promise<PortfolioProductResult> {
  const n = ctx.criteria.length;
  if (!product.readable) return restrictedProduct(product.id, n);

  const repos: PortfolioRepoResult[] = [];
  if (targets.repos.length > 0) {
    const { hitsByRepo, searched } = ctx.limits.perRepoSearch
      ? await retrievePerRepo(ctx, product.id, targets.repos)
      : await retrieveShared(ctx, product.id, targets.repos);
    for (const repo of targets.repos) {
      throwIfAborted(ctx.signal);
      const hits = hitsByRepo.get(repo.repoConnectionId) ?? [];
      if (ctx.repoVerdicts.has(repo.repoConnectionId)) {
        // #1726 — assessed already for another product in this run: reused (checked before this
        // product's own search result, so the same repo does not read "no evidence" here and a
        // verdict there), and its cost is not counted twice.
        const assessed = await ctx.repoVerdicts.get(repo.repoConnectionId)!;
        repos.push({ ...assessed, productId: product.id, costUsd: 0 });
      } else if (!searched.has(repo.projectId)) {
        repos.push(notVerified(product.id, repo, n, "retrieval-failed"));
      } else if (hits.length === 0) {
        repos.push(notVerified(product.id, repo, n, "no-evidence-retrieved"));
      } else if (!ctx.budget.allows(product.id)) {
        repos.push(notVerified(product.id, repo, n, "budget"));
      } else {
        const verdict = evaluateRepo(ctx, product.id, repo, hits);
        ctx.repoVerdicts.set(repo.repoConnectionId, verdict);
        repos.push(await verdict);
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
  notInScope: ReadonlySet<string> = new Set(),
): string {
  const failed = failedRepoLabels(products);
  const answer = verdictSummary(verdict, products, notInScope);
  return failed.length > 0
    ? `${answer} ${portfolioModelErrorText(failed, { leftOut: true })}`
    : answer;
}

/**
 * #1963 — the products a verdict left out as not in scope of the change
 * (`notInScopeOfChange`), named: not checked, and not reached by the change.
 */
function notInScopeSentence(outside: readonly PortfolioProductResult[]): string {
  const one = outside.length === 1;
  return `${portfolioNamedInProse(
    outside.map((p) => p.name),
    { sentenceStart: true },
  )} ${one ? "was" : "were"} not checked, but this change does not reach ${one ? "it" : "them"}, so ${one ? "it is" : "they are"} not in scope.`;
}

function verdictSummary(
  verdict: RequirementVerdict,
  allProducts: readonly PortfolioProductResult[],
  notInScope: ReadonlySet<string>,
): string {
  // #1963 — the verdict was rolled up without these; they are named after it.
  const outside = allProducts.filter((p) => notInScope.has(p.productId));
  const products = allProducts.filter((p) => !notInScope.has(p.productId));
  const outsideSentence = outside.length > 0 ? [notInScopeSentence(outside)] : [];
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
  const criteria = scoped.some((p) => p.readable)
    ? await decompose(base, input.criteria)
    : input.criteria.length > 0
      ? input.criteria
      : [input.statement];
  const query = [input.statement, ...criteria].join("\n").slice(0, MAX_QUERY_CHARS);
  const ctx: RunContext = {
    ...base,
    criteria,
    query,
    searched: criteria.map((c) => querySearchedFor(query, c)),
    repoVerdicts: new Map(),
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
  };
}

/**
 * #1963 — the gap result with its verdict and summary rolled up over the
 * products in scope of the change: a product not checked that the impact walk
 * does not reach (`notInScopeOfChange`) is left out of the verdict and named
 * after it. An `all-accessible` check reaches every product its starter can
 * see, so without this one unrelated product nobody indexed turns a gap the
 * changed products all confirm into "could not verify". With no product that
 * changes, nothing is known to be unrelated, and the result is as it was.
 */
export function scopedToChange(
  gap: PortfolioGapResult,
  impact: { products: readonly Pick<ProductImpact, "productId" | "restricted" | "impactKind">[] },
): PortfolioGapResult {
  const changes = impact.products.some((p) => p.impactKind === "direct-change");
  const unreached = new Set(
    changes
      ? impact.products
          .filter((p) => !p.restricted && p.impactKind === "none")
          .map((p) => p.productId)
      : [],
  );
  const notInScope = notInScopeOfChange(gap.products, unreached);
  if (notInScope.size === 0) return gap;
  const verdict = rollUpPortfolio(gap.products, notInScope);
  return {
    ...gap,
    verdict,
    summary: portfolioSummary(verdict, gap.products, notInScope),
    notInScope: [...notInScope].sort(),
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
}> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, deletedAt: null, ...(projectId ? { projectId } : {}) },
    select: { id: true, projectId: true, title: true, body: true, acceptanceCriteria: true },
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
