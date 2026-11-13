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
 */
import type { DocumentSource, RetrievalMatcher, RetrievedChunk } from "@metis/shared";
import { getUserAccessibleProjects } from "../auth/accessible-projects.js";
import {
  getKnowledgeService,
  type KnowledgeService,
  type QueryEmbedCache,
} from "./knowledge-service.js";
import { resolveAclActor, type AclActor } from "./acl.js";
import { createChildLogger } from "../logger.js";
import { fuseRetrievalHits } from "../ai/conversation/retrieval-query.js";

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
  /** The best relevance among `hits`. */
  relevance: number;
  /** #2279 — the chunk ids only the conversational search found in this project. */
  contextualOnly?: ReadonlySet<string>;
}

/**
 * #2238 — merge per-project rankings on relevance, not rank alone.
 *
 * 1. A project's relevance is its best hit's. A project below `floor` × the
 *    best project's relevance is left out: under rank fusion its first hit
 *    scored as high as the relevant project's first hit.
 * 2. The projects that remain take turns, in the order they were asked for,
 *    each giving its next hit in its own order, until `topK` hits are taken.
 *    Within a project its own ranking stands, so a hit only the keyword
 *    retriever found keeps its place there.
 *
 * When no hit anywhere carries a relevance (every hit lexical-only), nothing
 * can be compared and every project with a hit takes part.
 *
 * With `floor` 0 the result is exactly what rank fusion gave for distinct
 * chunks (each project's n-th hit tied at 1/(60+n), ties in project order), so
 * a caller that opts out of the floor — the portfolio gap engine, whose
 * coverage verdicts and replayed prompts depend on every project's evidence —
 * keeps its previous result.
 */
export function fuseByRelevance(
  rankings: readonly ProjectRanking[],
  topK: number,
  floor: number,
): FederatedHit[] {
  const withHits = rankings.filter((r) => r.hits.length > 0);
  const best = Math.max(0, ...withHits.map((r) => r.relevance));
  const kept = withHits.filter((r) => best <= 0 || r.relevance >= floor * best);
  const out: FederatedHit[] = [];
  const seen = new Set<string>();
  for (let depth = 0; out.length < topK; depth += 1) {
    let took = false;
    for (const r of kept) {
      if (out.length >= topK) break;
      const hit = r.hits[depth];
      if (!hit) continue;
      took = true;
      if (seen.has(hit.chunkId)) continue;
      seen.add(hit.chunkId);
      out.push(hit);
    }
    if (!took) break;
  }
  return out;
}

/**
 * #2279 — {@link fuseByRelevance}, with the hits only a follow-up's
 * conversational search found held to a minority of the `topK` slots across
 * every project, at most `floor((topK - 1) / 2)`, as single-project chat holds
 * them (`fuseRetrievalHits`): the user's own words stay in charge of what the
 * model reads. The relevance merge is prefix-stable, so it is taken whole and
 * then filled to `topK`.
 */
export function fuseCappingContextual(
  rankings: readonly ProjectRanking[],
  topK: number,
  floor: number,
): FederatedHit[] {
  const depth = rankings.reduce((n, r) => n + r.hits.length, 0);
  const contextualOnly = new Set(rankings.flatMap((r) => [...(r.contextualOnly ?? [])]));
  const maxContextualOnly = Math.floor((topK - 1) / 2);
  const out: FederatedHit[] = [];
  let taken = 0;
  for (const hit of fuseByRelevance(rankings, depth, floor)) {
    if (out.length >= topK) break;
    if (contextualOnly.has(hit.chunkId)) {
      if (taken >= maxContextualOnly) continue;
      taken += 1;
    }
    out.push(hit);
  }
  return out;
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
    const accessible = await getUserAccessibleProjects(userId);
    const accessibleMap = new Map(accessible.map((p) => [p.id, p.name]));

    // 2. Determine target projects — intersect with accessible
    let targetIds: string[];
    let rejectedCount = 0;
    if (opts.projectIds && opts.projectIds.length > 0) {
      targetIds = opts.projectIds.filter((id) => accessibleMap.has(id));
      const rejected = opts.projectIds.filter((id) => !accessibleMap.has(id));
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

    if (targetIds.length === 0) return emptyResult(rejectedCount);

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
        const { hits: ranked, contextualOnly } = result.value;
        const hits: FederatedHit[] = ranked.map((h) => ({ ...h, projectId, projectName }));
        rankings.push({
          projectId,
          hits,
          relevance: Math.max(0, ...hits.map((h) => h.score)),
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
    const fused = contextualQuery
      ? fuseCappingContextual(rankings, k, floor)
      : fuseByRelevance(rankings, k, floor);
    const contributing = new Set(fused.map((h) => h.projectId));

    return {
      hits: fused,
      projectsSearched,
      projectsFailed: failures.map((f) => f.projectId),
      totalHits: fused.length,
      projectsWithoutHits: projectsSearched.filter((id) => !contributing.has(id)),
      failures,
      projectsRejected: rejectedCount,
      projectNames: Object.fromEntries(
        targetIds.map((id) => [id, accessibleMap.get(id) ?? id] as const),
      ),
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
  ): Promise<{ hits: ProjectHit[]; contextualOnly?: Set<string> }> {
    const queries = [...userQueries, ...(contextualQuery ? [contextualQuery] : [])];
    const lists = await Promise.all(
      queries.map(async (q): Promise<ProjectHit[]> => {
        const r = await this.searchWithTimeout(projectId, q, search);
        const reranked = r.reranked === true;
        return r.hits.map((h) => ({
          chunkId: h.chunkId,
          documentId: h.documentId,
          filename: h.filename,
          ...(h.path ? { path: h.path } : {}),
          position: h.position,
          text: h.text,
          score: hitRelevance(h.score, reranked),
          ...(h.matchedBy ? { matchedBy: h.matchedBy } : {}),
          ...(h.source ? { source: h.source } : {}),
          ...(h.derived ? { derived: h.derived } : {}),
        }));
      }),
    );
    if (lists.length === 1) return { hits: lists[0]! };
    const userLists = lists.slice(0, userQueries.length);
    const contextualList = contextualQuery ? lists[userQueries.length]! : null;
    const hits = fuseRetrievalHits(userLists, contextualList, perProjectDepth(search.k));
    if (!contextualList) return { hits };
    const userFound = new Set(userLists.flatMap((l) => l.map((h) => h.chunkId)));
    return {
      hits,
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
