/**
 * Issue #532 — Federated Search Service.
 *
 * Orchestrates cross-project search by fanning out to per-project
 * KnowledgeService.search() calls in parallel, then merging the projects'
 * results on their relevance to the query (#2238).
 *
 * Security invariant: the user MUST have access to every project searched.
 * This is ENFORCED, not assumed (#1052): `getUserAccessibleProjects` resolves
 * the caller's workspace-scoped project set from the database, and a
 * caller-supplied `projectIds` list can only ever NARROW that set — ids outside
 * it are dropped before any per-project index is queried, so a widening attempt
 * yields no hits rather than an error (cross-tenant projects are invisible, not
 * forbidden). If that helper is ever loosened again, this fan-out has no second
 * line of defence.
 *
 * #2225 — and within a project, chunk ACLs hold: every per-project search runs
 * with the caller as the ACL actor, resolved once from durable state.
 *
 * #2238 — the merge is no longer rank-only. Reciprocal rank fusion gave every
 * project's first hit the same score however irrelevant it was, so a project
 * that had nothing to do with the question still put its top chunk in the
 * answer. Each project now carries its own relevance (its best hit's), a
 * project well below the best project's contributes nothing, and the projects
 * that clear the floor share the result fairly. A project that timed out or
 * failed is reported by name and reason (`failures`), never just dropped.
 *
 * #2264 — and the projects that clear the floor no longer take equal turns:
 * their hits are merged on relevance (see `byRelevance`), so a
 * distractor that clears the floor cannot claim one slot in every round from
 * the product that holds the answer. A project the merge leaves out only
 * because `k` was full is reported apart from one that matched nothing
 * (`projectsCapped`). Projects are compared on one scale even when only some
 * of them were reranked, a scope can be held to `maxProjects`, and an archived
 * project the caller can still reach is reported as archived, not as
 * unavailable.
 */
import type { DocumentSource, RetrievalMatcher, RetrievedChunk } from "@metis/shared";
import { getUserProjectScope } from "../auth/accessible-projects.js";
import {
  getKnowledgeService,
  type KnowledgeService,
  type QueryEmbedCache,
} from "./knowledge-service.js";
import { resolveAclActor, type AclActor } from "./acl.js";
import { createChildLogger } from "../logger.js";
import { fuseRetrievalHits } from "../ai/conversation/retrieval-query.js";
import { denseCosine, floorKeep } from "../ai/relevance-floor.js";

const log = createChildLogger("federated-search");

const DEFAULT_K = 10;
const DEFAULT_TIMEOUT_MS = 3000;
/**
 * #2238 — the share of the best project's relevance another project must reach
 * to contribute. A first cut, to be tuned against the epic's Phase 0 question
 * set (#2228); chat reads `CHAT_MULTI_PROJECT_RELEVANCE_FLOOR_PCT`.
 */
export const DEFAULT_RELEVANCE_FLOOR = 0.75;

// ─── Public types ───────────────────────────────────────────────────────────

export interface FederatedSearchOptions {
  userId: string;
  projectIds?: string[];
  query: string;
  k?: number;
  timeoutMs?: number;
  /**
   * #2238 — a project contributes only when its relevance is at least this
   * share (0..1) of the most relevant project's. `0` keeps every project with
   * a hit. Default {@link DEFAULT_RELEVANCE_FLOOR}.
   */
  relevanceFloor?: number;
  /**
   * #2279 — more of the user's own searches (the parts of a multi-part
   * question, `planSearches`). Each project runs them with `query`.
   */
  moreQueries?: string[];
  /**
   * #2279 — the conversational search of a follow-up (`planSearches`). Each
   * project merges every search with `fuseRetrievalHits`, as single-project
   * chat does, before the projects are merged; and the hits only this search
   * found are held to a minority of the `k` slots across all the projects.
   */
  contextualQuery?: string | null;
  /** #2279 — the documents attached to the question: every search covers only these. */
  documentIds?: string[];
  /**
   * #2294 — chat's absolute relevance floor (#2241) on each hit's dense
   * cosine, given the embedding models the hits were scored with (chat passes
   * `readRelevanceFloor`). It is applied to each project's own ranking BEFORE
   * the projects are merged, so a weak hit's slot goes to the next one that
   * clears it, and a project left with nothing contributes nothing. Off when
   * absent or when it returns 0.
   */
  absoluteFloor?: (embeddingModels: readonly string[]) => number;
  /**
   * #2264 — how the projects that clear the floor share the `k` slots.
   * `"relevance"` (default): their hits are merged on relevance, so a less
   * relevant project gets fewer slots or none.
   * `"turns"`: they take one slot each in turn, in the order asked for — the
   * portfolio gap engine's and attached documents' "every project counts" share.
   */
  share?: "relevance" | "turns";
  /**
   * #2264 — search at most this many projects. Over it, the projects the
   * caller most recently updated are searched (`getUserAccessibleProjects`'
   * order) and the rest are reported in `projectsOverLimit`. Unset: no limit.
   */
  maxProjects?: number;
}

export interface FederatedHit {
  chunkId: string;
  projectId: string;
  projectName: string;
  documentId: string;
  filename: string;
  /** #717 — a repository file's real path, set only for a `repo` row. */
  path?: string;
  position: number;
  text: string;
  /**
   * #2238 — the hit's relevance to the query, 0..1: the dense cosine, or the
   * cross-encoder's verdict (logistic of its logit) when the project's search
   * was reranked. Comparable across projects: every project's search embeds
   * the same query with the same embedder and, when on, the same reranker.
   */
  score: number;
  /** #2238 — carried from the project's search so a reader can label the hit. */
  matchedBy?: RetrievalMatcher[];
  source?: DocumentSource;
  derived?: RetrievedChunk["derived"];
  /** #2294 — the dense cosine when a rerank rewrote `score`, for the absolute floor. */
  denseScore?: number;
  /** #2294 — the model the hit was embedded with: the floor is calibrated per model. */
  embeddingModel?: string;
}

/** #2238 — a project that could not be searched, and why. */
export interface FederatedProjectFailure {
  projectId: string;
  projectName: string;
  reason: "timeout" | "error";
}

export interface FederatedSearchResult {
  hits: FederatedHit[];
  projectsSearched: string[];
  /** Ids of the projects that could not be searched; `failures` says which and why. */
  projectsFailed: string[];
  totalHits: number;
  /**
   * #2238 — searched projects none of whose hits is in `hits`: nothing matched,
   * nothing cleared the relevance floor, or the other projects filled `k`.
   */
  projectsWithoutHits: string[];
  /** #2238 — each project that timed out or failed, by name and reason. */
  failures: FederatedProjectFailure[];
  /**
   * #2238 — how many requested ids the caller cannot reach (or no longer can).
   * A count, never the ids' names: an unreachable project's existence is not
   * disclosed (#1052).
   */
  projectsRejected: number;
  /** #2238 — the name of every project searched or failed (all reachable by the caller). */
  projectNames: Record<string, string>;
  /**
   * #2294 — how many of the hits the merge would have returned without the
   * absolute floor fell below it (0, or absent, when it is off).
   */
  belowFloor?: number;
  /**
   * #2264 — searched projects that cleared the relevance floor but got no slot
   * because more relevant projects' hits filled `k`. Also in
   * `projectsWithoutHits`; listed apart so a reader does not call them
   * "nothing relevant".
   */
  projectsCapped?: string[];
  /** #2264 — reachable projects not searched because the scope was over `maxProjects`. */
  projectsOverLimit?: string[];
  /**
   * #2264 — requested projects the caller can reach that are archived, so not
   * searched. Named in `projectNames`; not counted in `projectsRejected`.
   */
  projectsArchived?: string[];
}

class FederatedSearchTimeoutError extends Error {}

/** What every search of one project in a federated call shares. */
interface ProjectSearch {
  k: number;
  timeoutMs: number;
  actor: AclActor;
  documentIds?: string[];
  /** #2279 — each distinct query string is embedded once per call, not once per project. */
  embedCache: QueryEmbedCache;
}

/** A hit in a project's own ranking, before it is labelled with the project. */
type ProjectHit = Omit<FederatedHit, "projectId" | "projectName">;

// ─── Relevance ──────────────────────────────────────────────────────────────

/**
 * #2238 — a hit's `score` as a 0..1 relevance. Without a rerank it is the dense
 * cosine (`0` for a hit only the lexical retriever found); with one it is the
 * cross-encoder's raw logit, mapped through the logistic function.
 */
export function hitRelevance(score: number, reranked: boolean): number {
  if (!Number.isFinite(score)) return 0;
  if (reranked) return 1 / (1 + Math.exp(-score));
  return Math.min(1, Math.max(0, score));
}

interface ProjectRanking {
  projectId: string;
  /** The project's own order (its fused, possibly reranked, ranking). */
  hits: FederatedHit[];
  /**
   * #2264 — every search of this project was reranked, so each hit's `score`
   * is the cross-encoder's verdict rather than its dense cosine.
   */
  reranked?: boolean;
  /** #2279 — the chunk ids only the conversational search found in this project. */
  contextualOnly?: ReadonlySet<string>;
}

/** A hit's relevance on the scale the projects are compared on; `null` when it has none. */
type Relevance = ((hit: FederatedHit) => number | null) & {
  /**
   * Whether each project's own ranking was made on this scale: true for the
   * cross-encoder's verdict, which ordered every reranked project; false for
   * the dense cosine, which a hybrid project's fusion (dense and keyword ranks)
   * did not follow.
   */
  readonly ranksProjects: boolean;
};

/**
 * #2264 — the one scale every project with a hit is compared on. When every
 * one of them was reranked it is the cross-encoder's verdict (`score`). When
 * any was not (the reranker is off, or fell back for one project) it is the
 * dense cosine (`denseCosine`): comparing one project's logistic verdicts with
 * another's cosines let the floor drop the wrong project. A hit only the
 * keyword retriever found has no cosine, so on that scale it has no relevance.
 */
function relevanceScale(rankings: readonly ProjectRanking[]): Relevance {
  const withHits = rankings.filter((r) => r.hits.length > 0);
  if (withHits.length > 0 && withHits.every((r) => r.reranked === true)) {
    return Object.assign((h: FederatedHit) => h.score, { ranksProjects: true });
  }
  return Object.assign(
    (h: FederatedHit) => {
      const cosine = denseCosine(h);
      return cosine !== null && cosine > 0 ? Math.min(1, cosine) : null;
    },
    { ranksProjects: false },
  );
}

/** A project's relevance: its best hit's. */
function projectRelevance(r: ProjectRanking, rel: Relevance): number {
  return Math.max(0, ...r.hits.map((h) => rel(h) ?? 0));
}

/**
 * #2279 — the relevance the relative floor is measured against: the best hit
 * the user's own words found, whenever they found any. A hit only a follow-up's
 * conversational search found never raises the bar, so it cannot push out a
 * product the user's new words matched; it can still bring its own product in,
 * since that product's relevance counts every hit it has. With no user-word
 * hit anywhere, the best hit of any kind.
 */
function floorReference(rankings: readonly ProjectRanking[], rel: Relevance): number {
  const userWord = rankings.flatMap((r) => r.hits.filter((h) => !r.contextualOnly?.has(h.chunkId)));
  const pool = userWord.length > 0 ? userWord : rankings.flatMap((r) => r.hits);
  return Math.max(0, ...pool.map((h) => rel(h) ?? 0));
}

/** #2238 — the projects with a hit whose relevance clears `floor` × the reference. */
function keptRankings(
  rankings: readonly ProjectRanking[],
  floor: number,
  rel: Relevance,
): { kept: ProjectRanking[]; best: number } {
  const withHits = rankings.filter((r) => r.hits.length > 0);
  const best = floorReference(withHits, rel);
  const kept = withHits.filter((r) => best <= 0 || projectRelevance(r, rel) >= floor * best);
  return { kept, best };
}

/** #2238 — the kept projects take one slot each in turn, in the order asked for. */
function inTurns(kept: readonly ProjectRanking[]): FederatedHit[] {
  const out: FederatedHit[] = [];
  const longest = Math.max(0, ...kept.map((r) => r.hits.length));
  for (let depth = 0; depth < longest; depth += 1) {
    for (const r of kept) {
      const hit = r.hits[depth];
      if (hit) out.push(hit);
    }
  }
  return out;
}

/**
 * #2264 — the kept projects' hits merged on relevance.
 *
 * On the verdict scale every project was ranked by that verdict, so a hit's
 * place is the lowest relevance of it and of every hit its project ranked
 * above it: the project's list is never reordered.
 *
 * On the cosine scale it is the hit's own cosine. A hybrid project's order is
 * its fusion of dense and keyword ranks, which the cosine does not follow, so
 * the running minimum let one weak-cosine hit near the top of a project cap
 * every hit below it; a project holding the best cosine of all then lost every
 * slot to a project whose order happened to agree with the scale. The places
 * now only decide how many slots each project gets, and when: the project
 * fills them from the top of its own ranking, so its order still stands (and
 * one project alone keeps exactly its own ranking).
 *
 * On either scale a hit with no relevance (keyword-only) takes the place of
 * the hit its project ranked just above it, so it stands where its project's
 * fusion put it. Every place starts at most at the best the user's own words found (`best`),
 * so a hit only a follow-up's conversational search found ranks no higher
 * than that, as it cannot raise the floor's bar either. Ties go to the
 * shallower hit, then to the more relevant project, then to the order asked
 * for, so when nothing carries a relevance this is the turns.
 */
function byRelevance(
  kept: readonly ProjectRanking[],
  best: number,
  rel: Relevance,
): FederatedHit[] {
  const projects = kept
    .map((r) => {
      const top = projectRelevance(r, rel);
      return { r, top: best > 0 ? Math.min(top, best) : top };
    })
    .sort((a, b) => b.top - a.top);
  const placed: {
    hit: FederatedHit;
    key: number;
    depth: number;
    order: number;
  }[] = [];
  projects.forEach(({ r, top }, order) => {
    let key = top;
    r.hits.forEach((hit, depth) => {
      const own = rel(hit);
      if (own !== null) key = Math.min(rel.ranksProjects ? key : top, own);
      placed.push({ hit, key, depth, order });
    });
  });
  placed.sort((a, b) => b.key - a.key || a.depth - b.depth || a.order - b.order);
  // The places decide how many slots each project gets and when; the project
  // fills them in its own order. On the verdict scale that is the placed hit
  // itself (its keys never rise down its list).
  const next = projects.map(() => 0);
  return placed.map((p) => projects[p.order]!.r.hits[next[p.order]!++]!);
}

/** The merged order, one copy of each chunk, cut to `topK`. */
function take(order: readonly FederatedHit[], topK: number): FederatedHit[] {
  const out: FederatedHit[] = [];
  const seen = new Set<string>();
  for (const hit of order) {
    if (out.length >= topK) break;
    if (seen.has(hit.chunkId)) continue;
    seen.add(hit.chunkId);
    out.push(hit);
  }
  return out;
}

/**
 * #2238 — merge per-project rankings on relevance, not rank alone.
 *
 * 1. A project's relevance is its best hit's, on one scale for every project
 *    ({@link relevanceScale}). A project below `floor` × the best relevance
 *    the user's own words found ({@link floorReference}) is left out: under
 *    rank fusion its first hit scored as high as the relevant project's first
 *    hit.
 * 2. #2264 — the projects that remain share `topK` by relevance
 *    ({@link byRelevance}): relevance decides how many slots each project
 *    gets, and each project fills them in its own order. Equal turns
 *    (`share: "turns"`) gave a distractor that cleared the floor one slot in
 *    every round, so with nine products in scope under a third of the excerpts
 *    came from the products holding the answer (#2336's sweep).
 *
 * When no hit anywhere carries a relevance (every hit lexical-only), nothing
 * can be compared and every project with a hit takes part, in turns.
 *
 * With `floor` 0 and `share: "turns"` the result is exactly what rank fusion
 * gave for distinct chunks (each project's n-th hit tied at 1/(60+n), ties in
 * project order), so the portfolio gap engine, whose coverage verdicts and
 * replayed prompts depend on every project's evidence, keeps its result.
 */
export function fuseByRelevance(
  rankings: readonly ProjectRanking[],
  topK: number,
  floor: number,
  share: "relevance" | "turns" = "relevance",
): FederatedHit[] {
  const rel = relevanceScale(rankings);
  const { kept, best } = keptRankings(rankings, floor, rel);
  return take(share === "turns" ? inTurns(kept) : byRelevance(kept, best, rel), topK);
}

/**
 * #2279 — {@link fuseByRelevance}, with the hits only a follow-up's
 * conversational search found held to a minority of the `topK` slots across
 * every project, at most `floor((topK - 1) / 2)` (single-project chat's cap in
 * `fuseRetrievalHits`, which since #2316 adds them beside the user's own `k`
 * instead): the user's own words stay in charge of what the model reads. The relevance merge is prefix-stable, so it is taken whole and
 * then filled to `topK`.
 */
export function fuseCappingContextual(
  rankings: readonly ProjectRanking[],
  topK: number,
  floor: number,
  share: "relevance" | "turns" = "relevance",
): FederatedHit[] {
  const depth = rankings.reduce((n, r) => n + r.hits.length, 0);
  const contextualOnly = new Set(rankings.flatMap((r) => [...(r.contextualOnly ?? [])]));
  const maxContextualOnly = Math.floor((topK - 1) / 2);
  const out: FederatedHit[] = [];
  let taken = 0;
  for (const hit of fuseByRelevance(rankings, depth, floor, share)) {
    if (out.length >= topK) break;
    if (contextualOnly.has(hit.chunkId)) {
      if (taken >= maxContextualOnly) continue;
      taken += 1;
    }
    out.push(hit);
  }
  return out;
}

/** #2264 — the ids of the projects in `rankings` that clear the relative floor. */
function clearingFloor(rankings: readonly ProjectRanking[], floor: number): Set<string> {
  return new Set(
    keptRankings(rankings, floor, relevanceScale(rankings)).kept.map((r) => r.projectId),
  );
}

/** How deep each project's own search, and its own ranking, goes for a merged `k`. */
function perProjectDepth(k: number): number {
  return Math.max(k * 2, 20);
}

// ─── Service ────────────────────────────────────────────────────────────────

function emptyResult(projectsRejected = 0): FederatedSearchResult {
  return {
    hits: [],
    projectsSearched: [],
    projectsFailed: [],
    totalHits: 0,
    projectsWithoutHits: [],
    failures: [],
    projectsRejected,
    projectNames: {},
    belowFloor: 0,
  };
}

/**
 * #2294 — each project's ranking with the hits below chat's absolute floor
 * taken out, as `applyRelevanceFloor` takes them out of one project's list: a
 * dense hit must reach the floor, and a keyword-only hit (no cosine) stays only
 * when some dense hit of its own project cleared it. `null` when the floor is off.
 */
function applyAbsoluteFloor(
  rankings: readonly ProjectRanking[],
  floorFor: FederatedSearchOptions["absoluteFloor"],
): { rankings: ProjectRanking[]; keep: (h: FederatedHit) => boolean } | null {
  if (!floorFor) return null;
  const all = rankings.flatMap((r) => r.hits);
  const floor = floorFor(all.flatMap((h) => (h.embeddingModel ? [h.embeddingModel] : [])));
  if (!(floor > 0)) return null;
  // Per project, as for one project: a keyword-only hit is vouched for by a
  // dense hit of its own project, never by another product's.
  const keeps = new Map(rankings.map((r) => [r.projectId, floorKeep(r.hits, floor)]));
  const keep = (h: FederatedHit) => keeps.get(h.projectId)?.(h) ?? true;
  return {
    keep,
    rankings: rankings.map((r) => ({ ...r, hits: r.hits.filter(keep) })),
  };
}

export class FederatedSearchService {
  private readonly knowledgeService: KnowledgeService;

  constructor(deps: { knowledgeService?: KnowledgeService } = {}) {
    this.knowledgeService = deps.knowledgeService ?? getKnowledgeService();
  }

  async searchAcrossProjects(opts: FederatedSearchOptions): Promise<FederatedSearchResult> {
    const { userId, query, k = DEFAULT_K, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
    const floor = Math.min(1, Math.max(0, opts.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR));

    if (!query || query.trim().length === 0) return emptyResult();

    // 1. Resolve accessible projects for this user
    const scope = await getUserProjectScope(userId);
    const accessible = scope.accessible;
    const accessibleMap = new Map(accessible.map((p) => [p.id, p.name]));

    // 2. Determine target projects — intersect with accessible
    let targetIds: string[];
    let rejectedCount = 0;
    const archived: { id: string; name: string }[] = [];
    if (opts.projectIds && opts.projectIds.length > 0) {
      targetIds = opts.projectIds.filter((id) => accessibleMap.has(id));
      let rejected = opts.projectIds.filter((id) => !accessibleMap.has(id));
      if (rejected.length > 0) {
        // #2264 — an archived project the caller can still reach is not
        // "unavailable": it is named as archived. Read through the same access
        // rule, so an unreachable id stays an anonymous count (#1052), and for
        // the caller already resolved: a workspace scope lists its archived
        // projects, so this runs on most of its turns.
        archived.push(...(await scope.archived(rejected)));
        const archivedIds = new Set(archived.map((p) => p.id));
        rejected = rejected.filter((id) => !archivedIds.has(id));
      }
      rejectedCount = rejected.length;
      if (rejected.length > 0) {
        log.warn("Rejected unauthorized project IDs in federated search", {
          userId,
          rejected,
        });
      }
    } else {
      targetIds = accessible.map((p) => p.id);
    }

    // #2264 — over `maxProjects`, the most recently updated projects are
    // searched (`accessible` is in that order) and the rest are named.
    let overLimit: string[] = [];
    const max = opts.maxProjects;
    if (max !== undefined && max > 0 && targetIds.length > max) {
      const recency = new Map(accessible.map((p, i) => [p.id, i]));
      const chosen = new Set(
        [...targetIds].sort((a, b) => recency.get(a)! - recency.get(b)!).slice(0, max),
      );
      overLimit = targetIds.filter((id) => !chosen.has(id));
      targetIds = targetIds.filter((id) => chosen.has(id));
    }
    const named = {
      ...Object.fromEntries(archived.map((p) => [p.id, p.name] as const)),
      ...Object.fromEntries(
        [...targetIds, ...overLimit].map((id) => [id, accessibleMap.get(id) ?? id] as const),
      ),
    };

    if (targetIds.length === 0) {
      return {
        ...emptyResult(rejectedCount),
        projectNames: named,
        ...(archived.length > 0 ? { projectsArchived: archived.map((p) => p.id) } : {}),
      };
    }

    // #2225 — before any search: a failed role read rejects the whole call.
    const actor = await resolveAclActor(userId);

    // 3. Fan out per-project searches with timeout
    const projectsSearched: string[] = [];
    const failures: FederatedProjectFailure[] = [];
    const rankings: ProjectRanking[] = [];

    // #2279 — a conversation-aware turn's searches, the user's own words first.
    const userQueries = [
      ...new Set([query, ...(opts.moreQueries ?? [])].map((q) => q.trim()).filter(Boolean)),
    ];
    const contextual = opts.contextualQuery?.trim() || null;
    const contextualQuery = contextual && !userQueries.includes(contextual) ? contextual : null;
    const documentIds =
      opts.documentIds && opts.documentIds.length > 0 ? [...opts.documentIds] : undefined;
    const search: ProjectSearch = {
      k,
      timeoutMs,
      actor,
      embedCache: new Map(),
      ...(documentIds ? { documentIds } : {}),
    };
    const results = await Promise.allSettled(
      targetIds.map((projectId) =>
        this.rankProject(projectId, userQueries, contextualQuery, search),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const projectId = targetIds[i];
      const projectName = accessibleMap.get(projectId) ?? projectId;
      const result = results[i];

      if (result.status === "fulfilled") {
        projectsSearched.push(projectId);
        const { hits: ranked, reranked, contextualOnly } = result.value;
        const hits: FederatedHit[] = ranked.map((h) => ({ ...h, projectId, projectName }));
        rankings.push({
          projectId,
          hits,
          reranked,
          ...(contextualOnly ? { contextualOnly } : {}),
        });
      } else {
        const reason = result.reason instanceof FederatedSearchTimeoutError ? "timeout" : "error";
        failures.push({ projectId, projectName, reason });
        log.warn("Project search failed in federated query", {
          projectId,
          reason,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    // 4. Cross-project fusion on relevance (#2238)
    const share = opts.share ?? "relevance";
    const merge = (r: readonly ProjectRanking[]) =>
      contextualQuery
        ? fuseCappingContextual(r, k, floor, share)
        : fuseByRelevance(r, k, floor, share);
    // #2294 — the absolute floor, per project before the merge, so the merge
    // backfills a weak hit's slot rather than returning fewer.
    const floored = applyAbsoluteFloor(rankings, opts.absoluteFloor);
    const merged = floored?.rankings ?? rankings;
    const fused = merge(merged);
    const belowFloor = floored ? merge(rankings).filter((h) => !floored.keep(h)).length : 0;
    const contributing = new Set(fused.map((h) => h.projectId));
    const without = projectsSearched.filter((id) => !contributing.has(id));
    // #2264 — relevant enough to contribute, but the slots were all taken. A
    // project whose only hits a follow-up's conversational search found is
    // not: the user's own words matched nothing in it, and the conversational
    // cap, not closer matches, may be what left it out.
    const relevant = clearingFloor(merged, floor);
    const userWordHit = new Set(
      merged
        .filter((r) => r.hits.some((h) => !r.contextualOnly?.has(h.chunkId)))
        .map((r) => r.projectId),
    );
    const capped = without.filter((id) => relevant.has(id) && userWordHit.has(id));

    return {
      hits: fused,
      projectsSearched,
      projectsFailed: failures.map((f) => f.projectId),
      totalHits: fused.length,
      projectsWithoutHits: without,
      failures,
      projectsRejected: rejectedCount,
      projectNames: named,
      belowFloor,
      ...(capped.length > 0 ? { projectsCapped: capped } : {}),
      ...(overLimit.length > 0 ? { projectsOverLimit: overLimit } : {}),
      ...(archived.length > 0 ? { projectsArchived: archived.map((p) => p.id) } : {}),
    };
  }

  /**
   * #2279 — one project's own ranking for a turn: every search of the plan,
   * each scored as a 0..1 relevance, merged as single-project chat merges them
   * (`fuseRetrievalHits`). Rejects when any search fails or times out, so the
   * project is reported as not searched rather than ranked on part of the plan.
   */
  private async rankProject(
    projectId: string,
    userQueries: readonly string[],
    contextualQuery: string | null,
    search: ProjectSearch,
  ): Promise<{ hits: ProjectHit[]; reranked: boolean; contextualOnly?: Set<string> }> {
    const queries = [...userQueries, ...(contextualQuery ? [contextualQuery] : [])];
    // #2264 — the project's scores are cross-encoder verdicts only when every
    // one of its searches was reranked.
    let reranked = true;
    const lists = await Promise.all(
      queries.map(async (q): Promise<ProjectHit[]> => {
        const r = await this.searchWithTimeout(projectId, q, search);
        if (r.reranked !== true) reranked = false;
        return r.hits.map((h) => ({
          chunkId: h.chunkId,
          documentId: h.documentId,
          filename: h.filename,
          ...(h.path ? { path: h.path } : {}),
          position: h.position,
          text: h.text,
          score: hitRelevance(h.score, r.reranked === true),
          ...(h.matchedBy ? { matchedBy: h.matchedBy } : {}),
          ...(h.source ? { source: h.source } : {}),
          ...(h.derived ? { derived: h.derived } : {}),
          ...(h.denseScore !== undefined ? { denseScore: h.denseScore } : {}),
          ...(h.embeddingModel ? { embeddingModel: h.embeddingModel } : {}),
        }));
      }),
    );
    if (lists.length === 1) return { hits: lists[0]!, reranked };
    const userLists = lists.slice(0, userQueries.length);
    const contextualList = contextualQuery ? lists[userQueries.length]! : null;
    const hits = fuseRetrievalHits(userLists, contextualList, perProjectDepth(search.k));
    if (!contextualList) return { hits, reranked };
    const userFound = new Set(userLists.flatMap((l) => l.map((h) => h.chunkId)));
    return {
      hits,
      reranked,
      contextualOnly: new Set(hits.filter((h) => !userFound.has(h.chunkId)).map((h) => h.chunkId)),
    };
  }

  /**
   * Search a single project with a timeout. Rejects if the search exceeds
   * the configured timeout.
   */
  private async searchWithTimeout(projectId: string, query: string, opts: ProjectSearch) {
    const { k, timeoutMs, actor, documentIds, embedCache } = opts;
    return new Promise<{
      hits: Pick<
        RetrievedChunk,
        | "chunkId"
        | "documentId"
        | "filename"
        | "path"
        | "position"
        | "text"
        | "score"
        | "matchedBy"
        | "source"
        | "derived"
        | "denseScore"
        | "embeddingModel"
      >[];
      reranked?: boolean;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new FederatedSearchTimeoutError(`Search timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.knowledgeService
        .search(projectId, query, {
          k: perProjectDepth(k),
          actor,
          embedCache,
          ...(documentIds ? { documentIds } : {}),
        })
        .then((result) => {
          clearTimeout(timer);
          resolve({ hits: result.hits, reranked: result.reranked });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let singleton: FederatedSearchService | null = null;

export function getFederatedSearchService(): FederatedSearchService {
  if (!singleton) singleton = new FederatedSearchService();
  return singleton;
}

/** Test seam — reset singleton between specs. */
export function __resetFederatedSearchSingleton(): void {
  singleton = null;
}
