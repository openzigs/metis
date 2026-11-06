/**
 * #1845 — replay the recorded chat turns through the semantic answer cache
 * (`ai/semantic-cache.ts`, #1844) and score every hit against a fresh run.
 *
 * Every question was asked fresh in each pass, so for any hit there is a fresh
 * answer to compare with: a hit is WRONG when the answer it serves cites a
 * different set of files ({@link sameFiles}). Nothing is judged by eye.
 *
 * The cache itself is the production class, at each threshold. What varies is
 * what it is keyed on and what it is allowed to store:
 *
 *   - `shipped`         — the shipped scope (system prompt incl. the per-question
 *                         retrieval block, content version, caller, conversation)
 *                         and the shipped store rule: never a turn that used a tool.
 *   - `store-tool-turns`— the shipped scope, but every turn is stored.
 *   - `question-only`   — every turn stored, and the scope leaves out the
 *                         per-question retrieval block, so two wordings of a
 *                         question can meet: the threshold's own precision.
 *   - `unversioned`     — as `question-only`, without the content version: what
 *                         the version key stops being served after a re-ingest.
 */
import {
  cosineSimilarity,
  SemanticResponseCache,
  shouldStoreTurn,
  type SemanticCacheScope,
} from "../../ai/semantic-cache.js";
import { jaccard, sameFiles } from "./cited-files.js";
import { pairLabel, type ChatCachePair, type PairLabel } from "./fixture.js";

export const SEMANTIC_THRESHOLDS = [0.92, 0.95, 0.97] as const;

export const REPLAY_VARIANTS = [
  "shipped",
  "store-tool-turns",
  "question-only",
  "unversioned",
] as const;
export type ReplayVariant = (typeof REPLAY_VARIANTS)[number];

/** One fresh chat turn, as the replay needs it. */
export interface ReplayTurn {
  pass: string;
  questionId: string;
  text: string;
  /** The question's embedding (the RAG embedder's). */
  embedding: number[];
  response: string;
  citedFiles: string[];
  toolCallCount: number;
  /** The shipped scope (`buildSemanticCacheScope`) of the turn's real prompt. */
  scope: SemanticCacheScope;
  /** Hash of the system prompt WITHOUT the per-question retrieval block. */
  stableSystemHash: string;
}

export type HitKind = PairLabel | "after-reingest" | "unrelated";

export interface ReplayHit {
  pass: string;
  questionId: string;
  servedFrom: { pass: string; questionId: string };
  match: "exact" | "similar";
  similarity: number;
  kind: HitKind;
  wrong: boolean;
  /** Overlap of the served and the fresh cited files (1 = the same set). */
  jaccard: number;
}

export interface ReplayResult {
  variant: ReplayVariant;
  threshold: number;
  lookups: number;
  stored: number;
  hits: number;
  wrongHits: number;
  exactHits: number;
  /**
   * Hits served across the re-ingest whose fresh answer cites a file the
   * re-ingest CREATED: the served answer predates that file, so it is stale
   * whatever the model's run-to-run variation.
   */
  staleHits: number;
  /** Mean overlap of served and fresh cited files over the hits; null with none. */
  meanJaccard: number | null;
  byKind: Partial<Record<HitKind, { hits: number; wrong: number }>>;
  detail: ReplayHit[];
}

function scopeFor(turn: ReplayTurn, variant: ReplayVariant): SemanticCacheScope {
  if (variant === "shipped" || variant === "store-tool-turns") return turn.scope;
  return {
    ...turn.scope,
    systemPromptHash: turn.stableSystemHash,
    ...(variant === "unversioned" ? { contentVersion: "unversioned" } : {}),
  };
}

function mayStore(turn: ReplayTurn, variant: ReplayVariant): boolean {
  return variant === "shipped"
    ? shouldStoreTurn({ response: turn.response, toolCallCount: turn.toolCallCount })
    : true;
}

/**
 * Replay `turns` in order: look each question up, and on a miss store its
 * fresh answer (as production does — a hit returns before anything is stored).
 */
export async function replaySemanticCache(
  turns: readonly ReplayTurn[],
  pairs: readonly ChatCachePair[],
  variant: ReplayVariant,
  threshold: number,
  /** Files the re-ingest created (the patch's new files). */
  newFiles: readonly string[] = [],
): Promise<ReplayResult> {
  const cache = new SemanticResponseCache({
    enabled: true,
    threshold,
    // The replay runs in seconds; a TTL or a size cap would only hide hits.
    ttlMinutes: 24 * 60,
    maxEntries: turns.length + 1,
  });
  const result: ReplayResult = {
    variant,
    threshold,
    lookups: 0,
    stored: 0,
    hits: 0,
    wrongHits: 0,
    exactHits: 0,
    staleHits: 0,
    meanJaccard: null,
    byKind: {},
    detail: [],
  };
  // The cache hands back the stored response; store an index and map it back.
  for (const [i, turn] of turns.entries()) {
    const scope = scopeFor(turn, variant);
    const query = { text: turn.text, embedding: turn.embedding };
    result.lookups++;
    const hit = await cache.lookup(query, scope);
    if (hit) {
      const source = turns[Number(hit.response)];
      const kind: HitKind =
        source.pass !== turn.pass
          ? "after-reingest"
          : (pairLabel(pairs, source.questionId, turn.questionId) ?? "unrelated");
      const wrong = !sameFiles(source.citedFiles, turn.citedFiles);
      result.hits++;
      if (hit.match === "exact") result.exactHits++;
      if (
        kind === "after-reingest" &&
        turn.citedFiles.some((f) => newFiles.includes(f) && !source.citedFiles.includes(f))
      ) {
        result.staleHits++;
      }
      if (wrong) result.wrongHits++;
      const bucket = (result.byKind[kind] ??= { hits: 0, wrong: 0 });
      bucket.hits++;
      if (wrong) bucket.wrong++;
      result.detail.push({
        pass: turn.pass,
        questionId: turn.questionId,
        servedFrom: { pass: source.pass, questionId: source.questionId },
        match: hit.match,
        similarity: Number(hit.similarity.toFixed(4)),
        kind,
        wrong,
        jaccard: Number(jaccard(source.citedFiles, turn.citedFiles).toFixed(3)),
      });
      continue;
    }
    if (mayStore(turn, variant)) {
      await cache.store(query, scope, String(i));
      result.stored++;
    }
  }
  if (result.detail.length > 0) {
    const sum = result.detail.reduce((acc, d) => acc + d.jaccard, 0);
    result.meanJaccard = Number((sum / result.detail.length).toFixed(3));
  }
  return result;
}

/** Every variant at every threshold. */
export async function replayAll(
  turns: readonly ReplayTurn[],
  pairs: readonly ChatCachePair[],
  thresholds: readonly number[] = SEMANTIC_THRESHOLDS,
  newFiles: readonly string[] = [],
): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  for (const variant of REPLAY_VARIANTS) {
    for (const t of thresholds) {
      out.push(await replaySemanticCache(turns, pairs, variant, t, newFiles));
    }
  }
  return out;
}

export interface FreshAgreement {
  pass: string;
  label: PairLabel;
  pairs: number;
  /** Pairs whose two fresh answers cite exactly the same files. */
  sameFiles: number;
  /** Mean overlap of the two fresh answers' cited files. */
  meanJaccard: number;
}

/**
 * How often two FRESH runs agree, per pair label and pass: the noise floor a
 * "wrong" hit must be read against. A paraphrase pair whose fresh answers
 * already cite different files would be scored wrong even by a perfect cache.
 */
export function freshAgreement(
  turns: readonly ReplayTurn[],
  pairs: readonly ChatCachePair[],
): FreshAgreement[] {
  const passes = [...new Set(turns.map((t) => t.pass))];
  const out: FreshAgreement[] = [];
  for (const pass of passes) {
    const byQ = new Map(turns.filter((t) => t.pass === pass).map((t) => [t.questionId, t]));
    for (const label of ["paraphrase", "near-miss", "repeat"] as const) {
      let n = 0;
      let same = 0;
      let overlap = 0;
      for (const p of pairs.filter((x) => x.label === label)) {
        const a = byQ.get(p.a);
        const b = byQ.get(p.b);
        if (!a || !b) continue;
        n++;
        if (sameFiles(a.citedFiles, b.citedFiles)) same++;
        overlap += jaccard(a.citedFiles, b.citedFiles);
      }
      if (n > 0) {
        out.push({
          pass,
          label,
          pairs: n,
          sameFiles: same,
          meanJaccard: Number((overlap / n).toFixed(3)),
        });
      }
    }
  }
  return out;
}

/**
 * The embedding similarity of every labelled pair: where each label sits
 * against the thresholds, independent of any one run's answers.
 */
export function pairSimilarities(
  pairs: readonly ChatCachePair[],
  embeddings: ReadonlyMap<string, number[]>,
): Array<ChatCachePair & { similarity: number }> {
  return pairs.flatMap((p) => {
    const a = embeddings.get(p.a);
    const b = embeddings.get(p.b);
    return a && b ? [{ ...p, similarity: Number(cosineSimilarity(a, b).toFixed(4)) }] : [];
  });
}
