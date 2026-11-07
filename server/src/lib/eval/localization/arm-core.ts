/**
 * The contract every localization arm shares, and the helpers more than one
 * family of arms reads: the arm and output types, the agent-pass seam of the A3
 * arms (#1755), the seeding merge, the requirement text, the corpus's
 * graph-membership lookup and A0 itself (the baseline the other arms extend).
 *
 * #1810 — these lived in `arms.ts`, which also registers the A3 arms, while
 * `agent-arms.ts` imported them back: an import cycle. Both now import from
 * here, and `arms.ts` re-exports them for its existing importers.
 */
import {
  EDIT_POOL,
  FILE_HIT_DECAY,
  MAX_EDIT_FILES,
  MAX_SYMBOLS_PER_EDIT_FILE,
  MIN_FILE_SHARE,
  SEED_POOL_PER_QUERY,
  resolveChangeSeeds,
  type SeedSymbolRow,
  type StoredLinkDeps,
  type StoredLinkRow,
} from "../../impact-analysis/change-seeds.js";
import { extractChangesByShape } from "../../impact-analysis/change-request.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import type { AIProvider } from "../../ai/types.js";
import { DEFAULT_WEIGHTS } from "../../code-graph/hybrid-search.js";
import type { CitationTarget } from "../../traceability/seed-code-links-from-findings.js";
import {
  fileKey,
  type GapVerdict,
  type LocalizationCorpus,
  type LocalizationItem,
  type LocalizationSymbolRow,
} from "./corpus.js";
import type { CostMeter } from "./cost.js";
import type { AgentRunStats } from "./scorer.js";
import type { CorpusSearch } from "./search.js";
import type { StalenessOp } from "./staleness.js";

/** Which tools the agent pass gets. */
export type AgentToolset =
  /** Production's `assembleAgenticCodeTools` and seeded blocks. */
  | "graph"
  /** `list_files`, `read_file_slice`, `grep_files`; no seeded blocks. */
  | "files";

/** One agent pass: one requirement text against one repository of a corpus. */
export interface AgentPassRequest {
  corpus: string;
  repo: string;
  /** The analyst's text, as the "Evaluate new requirements" box receives it. */
  text: string;
  toolset: AgentToolset;
}

/** A citation of the pass's final answer, with its finding's confidence. */
export interface AgentCitation extends CitationTarget {
  confidence: number;
}

export interface AgentPassResult {
  /** Every citation that could be code, in answer order (findings, then citations). */
  citations: AgentCitation[];
  turns: number;
  toolCalls: number;
  /** The loop produced a schema-valid final answer. */
  answered: boolean;
}

export type AgentPass = (request: AgentPassRequest) => Promise<AgentPassResult>;

/** #1818 — one "Evaluate new requirements" run: an item's text against one repository. */
export interface AnalysisPassRequest {
  corpus: string;
  repo: string;
  /** The analyst's text, as the "Evaluate new requirements" box receives it. */
  text: string;
}

export interface AnalysisPassResult {
  analysisId: string;
  /** The analysis row's terminal status. */
  status: string;
  /** The requirements it persisted, in creation order: what an analyst runs impact on. */
  requirementIds: string[];
}

export type AnalysisPass = (request: AnalysisPassRequest) => Promise<AnalysisPassResult>;

/** #1818 — what the A7 arms read from the materialized eval database. */
export interface AnalysisArmIO {
  /** The real analysis run (`AnalysisOrchestrator.start`), awaited to its end. */
  pass: AnalysisPass;
  /** Production's `loadRequirementChanges`: one change per stored requirement. */
  loadRequirementChanges: (requirementIds: readonly string[]) => Promise<ChangedRequirement[]>;
  /**
   * Production's citation read (`prismaAgentCitationDeps`) for the project the
   * corpus's repository is materialized as.
   */
  loadCitations: (requirementId: string, corpus: string, repo: string) => Promise<StoredLinkRow[]>;
}

/**
 * #1834 — the staleness cycle the A7 staleness arms read through: the
 * committed patch of an item, applied to the materialized clones and
 * re-ingested (which re-validates the stored citations, #1831), then undone.
 */
export interface StalenessArmIO {
  /**
   * A digest of every committed patch set: in each staleness arm's
   * configuration, so a resume or merge under another patch set is refused.
   */
  patchSetDigest: string;
  /** The item's committed operations; throws when the corpus's set has none for it. */
  opsFor(corpus: string, itemId: string): readonly StalenessOp[];
  /** Apply the operations and re-ingest, run `read`, then restore and re-ingest. */
  withPatch<T>(corpus: string, ops: readonly StalenessOp[], read: () => Promise<T>): Promise<T>;
  /**
   * #1899 — re-ingest every repository of the corpus at its pinned commit with
   * no patch (a routine re-ingest: it re-validates the citations), then `read`.
   */
  withReingest<T>(corpus: string, read: () => Promise<T>): Promise<T>;
  /**
   * The corpus search over the patched rows (`patchedSymbolRows`): the
   * CLI's `buildCorpusSearch` with its embedding cache, so a renamed file's
   * rows are searched at their new path, as after a re-ingest.
   */
  searchFor(rows: readonly LocalizationSymbolRow[]): Promise<CorpusSearch>;
}

/** What an arm returns for one requirement (cost and time are the runner's). */
export interface ArmOutput {
  rankedFiles: string[];
  editCandidateFiles: string[];
  llmNamedFiles?: string[];
  verdict?: GapVerdict;
  /** #1755 — agent-loop turns this requirement took (an agent arm). */
  agentTurns?: number;
  /** #1810 — what the agent passes behind this reading did (an agent arm). */
  agent?: AgentRunStats;
  /**
   * #1755 — the cost of model work this reading REUSED from another arm's call
   * in the same run (one agent pass read two ways), added to what this call
   * spent so each reading reports what it costs on its own; null = unpriced.
   */
  reusedCostUsd?: number | null;
  /** #1755 — the wall-clock seconds of that reused work. */
  reusedSeconds?: number;
}

/** What the runner tells an arm about the reading it asks for. */
export interface LocalizeContext {
  /** 1-based run number: two arms reading one item in the same run may share model work. */
  run: number;
}

/** One configuration under test. */
export interface LocalizationArm {
  id: string;
  label: string;
  /** Everything that identifies the configuration; printed in every report. */
  configuration: Record<string, string | number | boolean>;
  localize(
    item: LocalizationItem,
    corpus: LocalizationCorpus,
    context?: LocalizeContext,
  ): Promise<ArmOutput>;
}

/** What an arm factory is given. A model-backed arm also receives its metered provider. */
export interface ArmDeps {
  search: CorpusSearch;
  /** The METERED provider (`meterProvider`), for an arm with a model in the loop. */
  provider?: AIProvider;
  /**
   * The model's weight in the A13 family's rank fusion (#1798). Default
   * `RERANK_MODEL_WEIGHT`; the in-sample tuning run sets it (`--rerank-weight`).
   */
  rerankWeight?: number;
  /** #1755 — the analysis agent pass over the materialized corpus (the A3 arms). */
  agentPass?: AgentPass;
  /** #1818 — "Evaluate new requirements" over the materialized corpus (the A7 arms). */
  analysis?: AnalysisArmIO;
  /** #1834 — the staleness cycle over the materialized corpus (the A7 staleness arms). */
  staleness?: StalenessArmIO;
  /** #1755 — the run's meter, to price an agent pass a second arm reuses. */
  meter?: CostMeter;
  /** Milliseconds; a seam for tests. */
  now?: () => number;
}

/** One seeding's files, in its own order. */
export interface SeedingFiles {
  edit: string[];
  other: string[];
}

/**
 * Merge several seedings (one per change the text splits into, per repository)
 * into one ranking. Round-robin by position, in input order, so a single seeding
 * keeps its own order exactly and no repository's top file is buried under
 * another's tail. Edit files come first; a file that is an edit candidate in any
 * seeding is one in the merge.
 */
export function mergeSeedings(seedings: readonly SeedingFiles[]): {
  rankedFiles: string[];
  editCandidateFiles: string[];
} {
  const interleave = (lists: string[][]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const longest = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const l of lists) {
        const f = l[i];
        if (f !== undefined && !seen.has(f)) {
          seen.add(f);
          out.push(f);
        }
      }
    }
    return out;
  };
  const editCandidateFiles = interleave(seedings.map((s) => s.edit));
  const editSet = new Set(editCandidateFiles);
  const others = interleave(seedings.map((s) => s.other)).filter((f) => !editSet.has(f));
  return { rankedFiles: [...editCandidateFiles, ...others], editCandidateFiles };
}

export function uniqueInOrder(files: string[]): string[] {
  return [...new Set(files)];
}

/** The text the arms are given, as an analyst would paste it into impact analysis. */
export function requirementText(item: Pick<LocalizationItem, "title" | "text">): string {
  return `${item.title}\n\n${item.text}`;
}

/**
 * A0 — the shipped seeding. The pasted text goes through the shape-aware
 * extractor production wires (`shapeAwareChangeExtractor`), and each change is
 * seeded by `resolveChangeSeeds` over production's `HybridCodeSearch` in every
 * repository of the corpus, exactly as `defaultSeedChange` does. No model is
 * called. Ranked files: the edit candidates, then the related hits and schema
 * seeds, in seeding order.
 */
export function createA0Arm(deps: ArmDeps): LocalizationArm {
  const { search } = deps;
  return {
    id: "A0",
    label: "A0 — shipped seeding (resolveChangeSeeds over HybridCodeSearch), no model",
    configuration: {
      stage: "resolveChangeSeeds (impact-analysis/change-seeds.ts)",
      extractor: "shapeAwareChangeExtractor",
      searcher: "HybridCodeSearch (BM25 + symbol vectors, RRF)",
      bm25Weight: DEFAULT_WEIGHTS.bm25Weight,
      vectorWeight: DEFAULT_WEIGHTS.vectorWeight,
      embeddingModel: search.embeddingModel,
      symbols: search.symbolsDigest,
      SEED_POOL_PER_QUERY,
      EDIT_POOL,
      MAX_EDIT_FILES,
      MIN_FILE_SHARE,
      FILE_HIT_DECAY,
      MAX_SYMBOLS_PER_EDIT_FILE,
      llm: false,
    },
    async localize(item, corpus) {
      const changes = extractChangesByShape(requirementText(item));
      const seedings: SeedingFiles[] = [];
      for (const repo of corpus.manifest.repos) {
        for (const change of changes) {
          const seeds = await resolveChangeSeeds(change, repo.name, {
            searcher: search.searcher,
            loadSymbols: search.loadSymbols,
            loadWriterIds: search.loadWriterIds,
          });
          const key = (m: { filePath: string }) => fileKey(repo.name, m.filePath);
          seedings.push({
            edit: uniqueInOrder(seeds.editCandidates.map(key)),
            other: uniqueInOrder([...seeds.related, ...seeds.schemaSeeds].map(key)),
          });
        }
      }
      return mergeSeedings(seedings);
    },
  };
}

/** The corpus's symbols of the given files in one repository: the graph-membership lookup. */
export function corpusFileSymbols(corpus: LocalizationCorpus): StoredLinkDeps["loadFileSymbols"] {
  return async (filePaths, repo) => {
    const wanted = new Set(filePaths);
    return corpus.symbols
      .filter((r) => r.repo === repo && wanted.has(r.filePath))
      .map((r): SeedSymbolRow => ({
        id: r.id,
        qualifiedName: r.qualifiedName,
        filePath: r.filePath,
        kind: r.kind,
        language: r.language,
        startLine: r.startLine,
        endLine: r.endLine,
        signature: r.signature ?? null,
      }));
  };
}
