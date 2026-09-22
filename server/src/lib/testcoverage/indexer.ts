/**
 * Test Coverage indexer (Epic #856, issue #860).
 *
 * Embeds normalised test cases into the project's vector store under a
 * synthetic namespace (`tc:{projectId}` for case-level docs, `tcs:{projectId}`
 * for step-level docs) and exposes search helpers tuned for the requirement
 * matching pipeline (consumed in #869).
 *
 * Incremental: each row's `chunkId` includes the case's `contentHash` so
 * re-indexing the same case is a no-op. Removal is atomic across both
 * namespaces.
 *
 * #72 — the two `embed()` calls below are the largest embedding consumers in a
 * coverage run (every test-case text, then every step text), and the run's
 * budget never saw them: the task-runner drives this phase before the coverage
 * service exists. The run's {@link CoverageCostTracker} is now threaded in so
 * "every embedder call a run makes is on the budget" holds for the whole run,
 * not only the phases the service owns.
 */
import type { NormalisedTestCase } from "@metis/shared";

import { getEmbedder } from "../rag/embedder.js";
import { type CoverageEmbeddingUsage, estimateEmbeddingTokens } from "./cost-tracker.js";
import {
  type SearchHit,
  type VectorRow,
  type VectorStore,
  getVectorStore,
} from "../rag/vector-store.js";

/** Synthetic namespace IDs — colon-separated to satisfy `assertProjectId`. */
export function caseNamespace(projectId: string): string {
  return `tc:${projectId}`;
}
export function stepNamespace(projectId: string): string {
  return `tcs:${projectId}`;
}

/** Compose a representative text for embedding a full test case. */
export function caseText(tc: NormalisedTestCase): string {
  const parts = [tc.title];
  if (tc.preconditions) parts.push(`Preconditions: ${tc.preconditions}`);
  if (tc.steps.length) {
    parts.push(
      "Steps:\n" +
        tc.steps
          .map((s, i) => `${i + 1}. ${s.action}${s.expected ? ` — ${s.expected}` : ""}`)
          .join("\n"),
    );
  }
  if (tc.expected) parts.push(`Expected: ${tc.expected}`);
  return parts.join("\n");
}

export function stepText(action: string, expected?: string): string {
  return expected ? `${action} → ${expected}` : action;
}

export interface IndexableCase {
  /** Stable database id of the persisted TestCaseDoc. */
  docId: string;
  contentHash: string;
  case: NormalisedTestCase;
}

export interface IndexerOptions {
  store?: VectorStore;
}

/**
 * The slice of {@link CoverageCostTracker} the index phase needs (#72). Narrow
 * on purpose: the indexer bills, it never reads the budget — embedding spend is
 * already incurred by the time it is recorded and does not stop a run (#77).
 */
export interface EmbeddingCostRecorder {
  record(usage: CoverageEmbeddingUsage): void;
}

export interface IndexCallOptions {
  /** The run's cost tracker. Omitted outside a budgeted run (#72). */
  cost?: EmbeddingCostRecorder;
}

export interface IndexResult {
  inserted: number;
  /** docIds skipped because their contentHash was already present. */
  skipped: string[];
}

export class TestCoverageIndexer {
  private readonly store: VectorStore;
  constructor(opts: IndexerOptions = {}) {
    this.store = opts.store ?? getVectorStore();
  }

  /**
   * Upsert every supplied case. Cases whose `chunkId` already exists in the
   * case namespace are skipped (idempotent re-runs). Step rows are flushed
   * for every case being inserted.
   */
  async index(
    projectId: string,
    cases: readonly IndexableCase[],
    options: IndexCallOptions = {},
  ): Promise<IndexResult> {
    if (cases.length === 0) return { inserted: 0, skipped: [] };
    const embedder = getEmbedder();
    const caseNs = caseNamespace(projectId);
    const stepNs = stepNamespace(projectId);

    // Determine which cases are already indexed.
    const skipped: string[] = [];
    const todo: IndexableCase[] = [];
    for (const c of cases) {
      const existing = await this.store.search(caseNs, new Array(embedder.dimension).fill(0), 1, {
        documentIds: [c.docId],
      });
      const alreadyIndexed = existing.some(
        (hit: SearchHit) => hit.row.metadata.chunkId === caseChunkId(c),
      );
      if (alreadyIndexed) skipped.push(c.docId);
      else todo.push(c);
    }
    if (todo.length === 0) return { inserted: 0, skipped };

    // Embed all case texts and step texts in one batch each.
    const caseTexts = todo.map((c) => caseText(c.case));
    const caseEmb = await embedder.embed(caseTexts);
    // #58 rule, applied to the index phase: the embedder key is read AFTER
    // `embed()` (a failed backend may have been swapped for the hash stub) and
    // the model is the one `embed()` itself reported.
    options.cost?.record({
      phase: "embedding",
      embedder: embedder.key,
      modelId: caseEmb.model,
      embeddingTokens: estimateEmbeddingTokens(caseTexts),
    });

    const stepEntries: { docId: string; step: number; text: string }[] = [];
    for (const c of todo) {
      c.case.steps.forEach((s, idx) => {
        stepEntries.push({ docId: c.docId, step: idx, text: stepText(s.action, s.expected) });
      });
    }
    let stepEmb: { vectors: number[][]; model: string; dimension: number };
    if (stepEntries.length) {
      const stepTexts = stepEntries.map((e) => e.text);
      stepEmb = await embedder.embed(stepTexts);
      options.cost?.record({
        phase: "embedding",
        embedder: embedder.key,
        modelId: stepEmb.model,
        embeddingTokens: estimateEmbeddingTokens(stepTexts),
      });
    } else {
      stepEmb = { vectors: [], model: caseEmb.model, dimension: caseEmb.dimension };
    }

    const caseRows: VectorRow[] = todo.map((c, i) => ({
      id: caseChunkId(c),
      vector: caseEmb.vectors[i],
      metadata: {
        documentId: c.docId,
        chunkId: caseChunkId(c),
        filename: `${c.case.source}:${c.docId}`,
        position: 0,
        text: caseTexts[i],
        embeddingModel: caseEmb.model,
        source: c.case.source,
        contentHash: c.contentHash,
      },
    }));
    const stepRows: VectorRow[] = stepEntries.map((e, i) => ({
      id: `${e.docId}:step:${e.step}`,
      vector: stepEmb.vectors[i],
      metadata: {
        documentId: e.docId,
        chunkId: `${e.docId}:step:${e.step}`,
        filename: `step:${e.docId}`,
        position: e.step,
        text: e.text,
        embeddingModel: stepEmb.model,
      },
    }));

    // Atomic-ish: replace prior step rows for the doc, then upsert case + steps.
    for (const c of todo) {
      // delete prior step rows for this doc
      const stale = await this.store.search(stepNs, new Array(embedder.dimension).fill(0), 1000, {
        documentIds: [c.docId],
      });
      if (stale.length > 0) {
        await this.store.deleteByChunkIds(
          stepNs,
          stale.map((h) => h.row.metadata.chunkId),
        );
      }
    }
    await this.store.upsert(caseNs, caseRows);
    if (stepRows.length > 0) await this.store.upsert(stepNs, stepRows);

    return { inserted: caseRows.length, skipped };
  }

  /** Remove every namespace row for a given docId. */
  async remove(projectId: string, docId: string): Promise<number> {
    const caseDeleted = await this.store.deleteByDocument(caseNamespace(projectId), docId);
    const stepDeleted = await this.store.deleteByDocument(stepNamespace(projectId), docId);
    return caseDeleted + stepDeleted;
  }

  /** Dense top-k search against the case namespace. */
  async searchCases(projectId: string, query: number[], k: number): Promise<SearchHit[]> {
    return this.store.search(caseNamespace(projectId), query, k);
  }

  async searchSteps(projectId: string, query: number[], k: number): Promise<SearchHit[]> {
    return this.store.search(stepNamespace(projectId), query, k);
  }
}

function caseChunkId(c: IndexableCase): string {
  return `${c.docId}:${c.contentHash}`;
}
