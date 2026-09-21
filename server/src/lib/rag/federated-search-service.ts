/**
 * Issue #532 — Federated Search Service.
 *
 * Orchestrates cross-project search by fanning out to per-project
 * KnowledgeService.search() calls in parallel, then merging results via
 * cross-project Reciprocal Rank Fusion (RRF, k=60).
 *
 * Security invariant: the user MUST have access to every project searched.
 * This is ENFORCED, not assumed (#1052): `getUserAccessibleProjects` resolves
 * the caller's workspace-scoped project set from the database, and a
 * caller-supplied `projectIds` list can only ever NARROW that set — ids outside
 * it are dropped before any per-project index is queried, so a widening attempt
 * yields no hits rather than an error (cross-tenant projects are invisible, not
 * forbidden). If that helper is ever loosened again, this fan-out has no second
 * line of defence.
 */
import { getUserAccessibleProjects } from "../auth/accessible-projects.js";
import { getKnowledgeService, type KnowledgeService } from "./knowledge-service.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("federated-search");

const DEFAULT_K = 10;
const DEFAULT_TIMEOUT_MS = 3000;
const RRF_K = 60;

// ─── Public types ───────────────────────────────────────────────────────────

export interface FederatedSearchOptions {
  userId: string;
  projectIds?: string[];
  query: string;
  k?: number;
  timeoutMs?: number;
}

export interface FederatedHit {
  chunkId: string;
  projectId: string;
  projectName: string;
  documentId: string;
  filename: string;
  position: number;
  text: string;
  score: number;
}

export interface FederatedSearchResult {
  hits: FederatedHit[];
  projectsSearched: string[];
  projectsFailed: string[];
  totalHits: number;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class FederatedSearchService {
  private readonly knowledgeService: KnowledgeService;

  constructor(deps: { knowledgeService?: KnowledgeService } = {}) {
    this.knowledgeService = deps.knowledgeService ?? getKnowledgeService();
  }

  async searchAcrossProjects(opts: FederatedSearchOptions): Promise<FederatedSearchResult> {
    const { userId, query, k = DEFAULT_K, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

    if (!query || query.trim().length === 0) {
      return { hits: [], projectsSearched: [], projectsFailed: [], totalHits: 0 };
    }

    // 1. Resolve accessible projects for this user
    const accessible = await getUserAccessibleProjects(userId);
    const accessibleMap = new Map(accessible.map((p) => [p.id, p.name]));

    // 2. Determine target projects — intersect with accessible
    let targetIds: string[];
    if (opts.projectIds && opts.projectIds.length > 0) {
      targetIds = opts.projectIds.filter((id) => accessibleMap.has(id));
      const rejected = opts.projectIds.filter((id) => !accessibleMap.has(id));
      if (rejected.length > 0) {
        log.warn("Rejected unauthorized project IDs in federated search", {
          userId,
          rejected,
        });
      }
    } else {
      targetIds = accessible.map((p) => p.id);
    }

    if (targetIds.length === 0) {
      return { hits: [], projectsSearched: [], projectsFailed: [], totalHits: 0 };
    }

    // 3. Fan out per-project searches with timeout
    const projectsSearched: string[] = [];
    const projectsFailed: string[] = [];
    const perProjectHits: Map<
      string,
      {
        chunkId: string;
        projectId: string;
        projectName: string;
        documentId: string;
        filename: string;
        position: number;
        text: string;
        score: number;
      }[]
    > = new Map();

    const results = await Promise.allSettled(
      targetIds.map((projectId) => this.searchWithTimeout(projectId, query, k, timeoutMs)),
    );

    for (let i = 0; i < results.length; i++) {
      const projectId = targetIds[i];
      const projectName = accessibleMap.get(projectId) ?? projectId;
      const result = results[i];

      if (result.status === "fulfilled") {
        projectsSearched.push(projectId);
        const hits = result.value.hits.map((h) => ({
          chunkId: h.chunkId,
          projectId,
          projectName,
          documentId: h.documentId,
          filename: h.filename,
          position: h.position,
          text: h.text,
          score: h.score,
        }));
        perProjectHits.set(projectId, hits);
      } else {
        projectsFailed.push(projectId);
        log.warn("Project search failed in federated query", {
          projectId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    // 4. Cross-project RRF fusion
    const fused = this.crossProjectRRF(perProjectHits, k);

    return {
      hits: fused,
      projectsSearched,
      projectsFailed,
      totalHits: fused.length,
    };
  }

  /**
   * Search a single project with a timeout. Rejects if the search exceeds
   * the configured timeout.
   */
  private async searchWithTimeout(projectId: string, query: string, k: number, timeoutMs: number) {
    return new Promise<{
      hits: {
        chunkId: string;
        documentId: string;
        filename: string;
        position: number;
        text: string;
        score: number;
      }[];
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Search timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.knowledgeService
        .search(projectId, query, { k: Math.max(k * 2, 20) })
        .then((result) => {
          clearTimeout(timer);
          resolve({ hits: result.hits });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Cross-project Reciprocal Rank Fusion.
   *
   * Each project's ranked list is treated as one input to RRF. For each hit
   * from project P at rank r, score = 1/(RRF_K + r). Scores are summed for
   * duplicate documents. Results are sorted by descending fused score.
   */
  private crossProjectRRF(
    perProjectHits: Map<
      string,
      {
        chunkId: string;
        projectId: string;
        projectName: string;
        documentId: string;
        filename: string;
        position: number;
        text: string;
        score: number;
      }[]
    >,
    topK: number,
  ): FederatedHit[] {
    const acc = new Map<string, { hit: FederatedHit; score: number }>();

    for (const [, hits] of perProjectHits) {
      hits.forEach((hit, idx) => {
        const rank = idx + 1;
        const rrfScore = 1 / (RRF_K + rank);
        const existing = acc.get(hit.chunkId);
        if (existing) {
          existing.score += rrfScore;
        } else {
          acc.set(hit.chunkId, {
            hit: { ...hit, score: 0 },
            score: rrfScore,
          });
        }
      });
    }

    const sorted = [...acc.values()]
      .map(({ hit, score }) => ({ ...hit, score }))
      .sort((a, b) => b.score - a.score);

    return sorted.slice(0, topK);
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
