/**
 * Issue #1837 (epic #1828) — similar and duplicate requirements for a stored
 * requirement or for draft text, each with its saved code links.
 *
 * Pipeline:
 *   1. vector candidates from the requirement index (#1835), which reconciles
 *      first, so the answer reflects every committed edit;
 *   2. BM25 candidates over the project's requirement titles and bodies, fused
 *      with (1) by reciprocal rank, so a requirement sharing a rare term is not
 *      lost to the embedder's ranking;
 *   3. a label from the cosine and the thresholds calibrated in #1836
 *      (`requirement-similarity-config.ts`); below the `related` floor a
 *      candidate is not similar at all and is dropped;
 *   4. optionally (`REQ_SIMILARITY_VERIFIER`, off) an LLM verifier relabels the
 *      candidates; an unreadable reply or a provider error keeps the threshold
 *      labels and is logged.
 *
 * Every read is scoped on the project AND the id, and the requirement asked
 * about is never in its own list.
 */
import type { PrismaClient } from "@prisma/client";
import MiniSearch from "minisearch";
import {
  SIMILAR_CODE_LINK_FRESHNESS,
  SIMILAR_CODE_LINKS_PER_ITEM,
  type SimilarCodeLinkFreshness,
  type SimilarRequirementCodeLink,
  type SimilarRequirementItem,
  type SimilarRequirementLabel,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";
import { codeAwareTerms, reciprocalRankFusion } from "../rag/bm25-index.js";
import { cosineSimilarity } from "../rag/vector-store.js";
import { getEmbedder } from "../rag/embedder.js";
import {
  findNearestRequirements,
  formatRequirementForEmbedding,
  type RequirementEmbeddingDeps,
} from "./requirement-embeddings.js";
import {
  labelForScore,
  REQUIREMENT_SIMILARITY_THRESHOLDS,
  type RequirementSimilarityThresholds,
} from "./requirement-similarity-config.js";
import type { SimilarityVerifier, VerifierLabel } from "./similarity-verifier.js";
import { resolveRequirementReviewStatus } from "../analysis/analysis-service.js";
import { parseRequirementLabels } from "../analysis/requirement-labels.js";

const log = createChildLogger("similar-requirements");

/** Vector and BM25 candidates fetched per call, before labelling and the limit. */
export const SIMILAR_CANDIDATE_POOL = 25;

export type SimilarRequirementsDb = Pick<
  PrismaClient,
  | "requirement"
  | "requirementEmbedding"
  | "requirementCodeMapping"
  | "requirementLink"
  | "requirementSimilarityDismissal"
>;

export interface SimilarRequirementsOptions extends Omit<RequirementEmbeddingDeps, "db"> {
  db?: SimilarRequirementsDb;
  limit?: number;
  thresholds?: RequirementSimilarityThresholds;
  /** The verifier to run; `null` or absent runs none. */
  verifier?: SimilarityVerifier | null;
}

export type SimilarityQuery =
  { requirementId: string } | { text: string; acceptanceCriteria?: readonly string[] };

const LABEL_ORDER: Record<SimilarRequirementLabel, number> = {
  duplicate: 0,
  overlap: 1,
  related: 2,
};

function freshnessOf(row: object): SimilarCodeLinkFreshness {
  // #1830 adds `freshness` to the mapping row; read it when the column exists.
  const value = (row as { freshness?: unknown }).freshness;
  return (SIMILAR_CODE_LINK_FRESHNESS as readonly unknown[]).includes(value)
    ? (value as SimilarCodeLinkFreshness)
    : "unverified";
}

interface Candidate {
  id: string;
  text: string;
  score: number;
  fused: number;
  label: SimilarRequirementLabel;
}

/**
 * Similar requirements for a stored requirement or for draft text, best first
 * (`duplicate`, then `overlap`, then `related`; fused rank within a label).
 *
 * @throws AppError 404 `REQUIREMENT_NOT_FOUND` — the requirement is not a live
 *         requirement of `projectId`.
 */
export async function findSimilarRequirements(
  projectId: string,
  query: SimilarityQuery,
  opts: SimilarRequirementsOptions = {},
): Promise<SimilarRequirementItem[]> {
  const db = opts.db ?? prisma;
  const thresholds = opts.thresholds ?? REQUIREMENT_SIMILARITY_THRESHOLDS;
  const limit = Math.max(1, Math.floor(opts.limit ?? 5));
  const embedService = opts.embedService ?? getEmbedder();

  let queryText: string;
  const exclude: string[] = [];
  if ("requirementId" in query) {
    const self = await db.requirement.findFirst({
      where: { id: query.requirementId, projectId, deletedAt: null },
      select: { id: true, title: true, body: true, acceptanceCriteria: true },
    });
    if (!self) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
    queryText = formatRequirementForEmbedding(self);
    exclude.push(self.id);
  } else {
    queryText = formatRequirementForEmbedding({
      title: query.text,
      body: "",
      acceptanceCriteria: JSON.stringify(query.acceptanceCriteria ?? []),
    });
  }

  const vectorHits = await findNearestRequirements(projectId, queryText, {
    ...opts,
    embedService,
    db,
    limit: SIMILAR_CANDIDATE_POOL,
    excludeIds: exclude,
  });

  const rows = await db.requirement.findMany({
    where: { projectId, deletedAt: null, id: { notIn: exclude } },
    select: { id: true, title: true, body: true, acceptanceCriteria: true },
  });
  const textOf = new Map(rows.map((r) => [r.id, formatRequirementForEmbedding(r)]));
  const bm25Hits = bm25Search(rows, queryText, SIMILAR_CANDIDATE_POOL);

  // A BM25-only candidate has no cosine yet: embed it beside the query, once.
  const cosine = new Map(vectorHits.map((h) => [h.requirementId, h.score]));
  const missing = bm25Hits.map((h) => h.chunkId).filter((id) => !cosine.has(id) && textOf.has(id));
  if (missing.length > 0) {
    const { vectors } = await embedService.embed([
      queryText,
      ...missing.map((id) => textOf.get(id) as string),
    ]);
    missing.forEach((id, i) => cosine.set(id, cosineSimilarity(vectors[0], vectors[i + 1])));
  }

  const fused = reciprocalRankFusion([
    vectorHits.map((h) => ({ chunkId: h.requirementId })),
    bm25Hits,
  ]);
  let candidates: Candidate[] = [];
  for (const f of fused) {
    const score = cosine.get(f.chunkId);
    const text = textOf.get(f.chunkId);
    if (score === undefined || text === undefined) continue;
    const label = labelForScore(score, thresholds);
    if (label) candidates.push({ id: f.chunkId, text, score, fused: f.score, label });
  }

  if (opts.verifier && candidates.length > 0) {
    candidates = await verify(opts.verifier, queryText, candidates, projectId);
  }

  candidates.sort((a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label] || b.fused - a.fused);
  return hydrate(
    db,
    projectId,
    candidates.slice(0, limit),
    "requirementId" in query ? query.requirementId : null,
  );
}

async function verify(
  verifier: SimilarityVerifier,
  queryText: string,
  candidates: Candidate[],
  projectId: string,
): Promise<Candidate[]> {
  let labels: VerifierLabel[] | null;
  try {
    labels = await verifier(
      queryText,
      candidates.map((c) => c.text),
    );
  } catch (err) {
    log.warn("similarity verifier failed; keeping the threshold labels", {
      projectId,
      error: (err as Error).message,
    });
    return candidates;
  }
  if (!labels) {
    log.warn("similarity verifier reply unreadable; keeping the threshold labels", { projectId });
    return candidates;
  }
  return candidates.flatMap((c, i) => {
    const label = labels[i];
    return label === "unrelated" ? [] : [{ ...c, label }];
  });
}

function bm25Search(
  rows: ReadonlyArray<{ id: string; title: string; body: string }>,
  queryText: string,
  k: number,
): Array<{ chunkId: string; score: number }> {
  if (rows.length === 0) return [];
  const index = new MiniSearch<{ id: string; text: string }>({
    fields: ["text"],
    processTerm: codeAwareTerms,
  });
  index.addAll(rows.map((r) => ({ id: r.id, text: `${r.title}\n${r.body}` })));
  return index
    .search(queryText, { combineWith: "OR", prefix: false, fuzzy: 0 })
    .slice(0, k)
    .map((h) => ({ chunkId: String(h.id), score: h.score }));
}

/** The two ids of a pair in the order a dismissal row stores them (lowest first). */
export function dismissalPair(
  a: string,
  b: string,
): { requirementId: string; otherRequirementId: string } {
  return a < b
    ? { requirementId: a, otherRequirementId: b }
    : { requirementId: b, otherRequirementId: a };
}

/**
 * #1838 — for a stored requirement's list: which candidates an analyst said are
 * not duplicates of it, and which a `duplicates` link already joins to it.
 */
async function pairDecisions(
  db: SimilarRequirementsDb,
  self: string | null,
  ids: string[],
): Promise<{ dismissed: Set<string>; linked: Set<string> }> {
  if (!self) return { dismissed: new Set(), linked: new Set() };
  const [dismissals, links] = await Promise.all([
    db.requirementSimilarityDismissal.findMany({
      where: {
        OR: [
          { requirementId: self, otherRequirementId: { in: ids } },
          { otherRequirementId: self, requirementId: { in: ids } },
        ],
      },
      select: { requirementId: true, otherRequirementId: true },
    }),
    db.requirementLink.findMany({
      where: {
        type: "duplicates",
        OR: [
          { sourceRequirementId: self, targetRequirementId: { in: ids } },
          { targetRequirementId: self, sourceRequirementId: { in: ids } },
        ],
      },
      select: { sourceRequirementId: true, targetRequirementId: true },
    }),
  ]);
  const other = (a: string, b: string): string => (a === self ? b : a);
  return {
    dismissed: new Set(dismissals.map((d) => other(d.requirementId, d.otherRequirementId))),
    linked: new Set(links.map((l) => other(l.sourceRequirementId, l.targetRequirementId))),
  };
}

async function hydrate(
  db: SimilarRequirementsDb,
  projectId: string,
  candidates: Candidate[],
  self: string | null,
): Promise<SimilarRequirementItem[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id);
  const [reqs, mappings, decisions] = await Promise.all([
    db.requirement.findMany({
      where: { projectId, id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        analysisId: true,
        title: true,
        reviewStatus: true,
        labels: true,
        promotedStructuredId: true,
        externalId: true,
      },
    }),
    // No `select`: every column is read, so #1830's `freshness` arrives when it exists.
    db.requirementCodeMapping.findMany({
      where: { projectId, requirementId: { in: ids } },
      orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
    }),
    pairDecisions(db, self, ids),
  ]);
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const links = new Map<string, SimilarRequirementCodeLink[]>();
  // #1931 — the requirements holding more links than the cap returns.
  const truncated = new Set<string>();
  for (const m of mappings) {
    const list = links.get(m.requirementId) ?? [];
    if (list.length >= SIMILAR_CODE_LINKS_PER_ITEM) {
      truncated.add(m.requirementId);
      continue;
    }
    list.push({
      mappingId: m.id,
      filePath: m.filePath,
      startLine: m.startLine,
      endLine: m.endLine,
      source: m.source,
      freshness: freshnessOf(m),
    });
    links.set(m.requirementId, list);
  }
  return candidates.flatMap((c) => {
    const r = byId.get(c.id);
    if (!r) return [];
    return [
      {
        requirementId: r.id,
        analysisId: r.analysisId,
        key: r.promotedStructuredId ?? r.externalId ?? null,
        title: r.title,
        status: resolveRequirementReviewStatus(r.reviewStatus, parseRequirementLabels(r.labels)),
        score: Math.round(c.score * 1000) / 1000,
        label: c.label,
        codeLinks: links.get(r.id) ?? [],
        codeLinksTruncated: truncated.has(r.id),
        notDuplicate: decisions.dismissed.has(r.id),
        linkedAsDuplicate: decisions.linked.has(r.id),
      },
    ];
  });
}

/**
 * #1838 — record an analyst's "Not a duplicate" for a pair of the project's live
 * requirements, so the duplicate warning stays down after a reload. Idempotent.
 *
 * @throws AppError 400 `SAME_REQUIREMENT` — the pair is one requirement.
 * @throws AppError 404 `REQUIREMENT_NOT_FOUND` — either is not a live requirement
 *         of `projectId` (looked up on the project AND the id).
 */
export async function markNotDuplicate(
  projectId: string,
  requirementId: string,
  otherRequirementId: string,
  dismissedById: string,
  db: Pick<SimilarRequirementsDb, "requirement" | "requirementSimilarityDismissal"> = prisma,
): Promise<void> {
  if (requirementId === otherRequirementId) {
    throw new AppError(400, "SAME_REQUIREMENT", "A requirement cannot be compared with itself");
  }
  const found = await db.requirement.count({
    where: { projectId, id: { in: [requirementId, otherRequirementId] }, deletedAt: null },
  });
  if (found !== 2) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
  const pair = dismissalPair(requirementId, otherRequirementId);
  await db.requirementSimilarityDismissal.upsert({
    where: { requirementId_otherRequirementId: pair },
    create: { ...pair, projectId, dismissedById },
    update: {},
  });
}
