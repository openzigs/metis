/**
 * #1753 — the arms the localization eval compares, chosen by EXPLICIT runner
 * options, never by ambient `IMPACT_LLM_*` variables: `eval-impact-recall.ts`
 * builds its LLM stages itself and reads no such variable
 * (docs/IMPACT_ANALYSIS_LLM_STAGES.md), so an environment flag would change
 * production behaviour without the harness being able to tell two arms apart.
 *
 * A0 is the shipped seeding and this issue's deliverable. Each later arm of
 * epic #1751 (A2 stored links #1754, A3 analysis-agent citations #1755, A4
 * rerank-and-verify #1756, A5 adaptive cap #1757, A6 summaries #1758, A7 agentic
 * seeder #1759, A8 BRD citations #1760, A9 LLM extractor #1761) adds a factory
 * to {@link ARM_FACTORIES} in its own PR; until then asking for it fails loudly.
 */
import {
  EDIT_POOL,
  FILE_HIT_DECAY,
  MAX_EDIT_FILES,
  MAX_SYMBOLS_PER_EDIT_FILE,
  MIN_FILE_SHARE,
  SEED_POOL_PER_QUERY,
  VERIFY_POOL_FILES,
  resolveChangeSeeds,
  type SeedSymbolRow,
  type StoredLinkDeps,
  type StoredLinkRow,
} from "../../impact-analysis/change-seeds.js";
import { extractChangesByShape, requestGateText } from "../../impact-analysis/change-request.js";
import {
  applyEditVerification,
  graphLineCheck,
  MAX_PROMOTIONS,
  verifyEditCandidates,
} from "../../impact-analysis/edit-candidate-verifier.js";
import type { AIProvider } from "../../ai/types.js";
import { DEFAULT_WEIGHTS } from "../../code-graph/hybrid-search.js";
import {
  DEFAULT_TOP_K,
  mapRequirementToCode,
  RELATIVE_MIN_CONFIDENCE,
  type CodeSymbolSearcher,
} from "../../traceability/requirement-code-mapping.js";
import { fileKey, type LocalizationCorpus, type LocalizationItem } from "./corpus.js";
import type { CorpusSearch } from "./search.js";
import type { GapVerdict } from "./corpus.js";

/** What an arm returns for one requirement (cost and time are the runner's). */
export interface ArmOutput {
  rankedFiles: string[];
  editCandidateFiles: string[];
  llmNamedFiles?: string[];
  verdict?: GapVerdict;
}

/** One configuration under test. */
export interface LocalizationArm {
  id: string;
  label: string;
  /** Everything that identifies the configuration; printed in every report. */
  configuration: Record<string, string | number | boolean>;
  localize(item: LocalizationItem, corpus: LocalizationCorpus): Promise<ArmOutput>;
}

/** What an arm factory is given. A model-backed arm also receives its metered provider. */
export interface ArmDeps {
  search: CorpusSearch;
  /** The METERED provider (`meterProvider`), for an arm with a model in the loop. */
  provider?: AIProvider;
}

/** The arms that call a model: the CLI builds a live, metered provider only for these. */
export const MODEL_ARMS: ReadonlySet<string> = new Set(["A4"]);

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

function uniqueInOrder(files: string[]): string[] {
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

/**
 * #1754 — the mapper over the corpus search, as the traceability mapping job
 * runs it: `mapRequirementToCode` with the hybrid searcher, hydrated from the
 * corpus rows. The corpus searcher vouches for no absolute confidence, so the
 * mapper normalizes to the best hit and keeps hits at or above
 * {@link RELATIVE_MIN_CONFIDENCE}, the top {@link DEFAULT_TOP_K}.
 */
function corpusMapperSearcher(search: CorpusSearch): CodeSymbolSearcher {
  return {
    async search(query, projectId, opts) {
      const hits = await search.searcher.search(query, projectId, { limit: opts?.limit });
      const rows = new Map(
        (
          await search.loadSymbols(
            hits.map((h) => h.symbolId),
            projectId,
          )
        ).map((r) => [r.id, r]),
      );
      return hits.flatMap((h) => {
        const r = rows.get(h.symbolId);
        return r
          ? [
              {
                symbolId: r.id,
                filePath: r.filePath,
                qualifiedName: r.qualifiedName,
                name: h.name,
                kind: r.kind,
                startLine: r.startLine,
                endLine: r.endLine,
                score: h.score,
              },
            ]
          : [];
      });
    },
  };
}

/** The corpus's symbols of the given files in one repository: the graph-membership lookup. */
function corpusFileSymbols(corpus: LocalizationCorpus): StoredLinkDeps["loadFileSymbols"] {
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

/**
 * A2 — A0 plus the stored-link channel (#1754): every change of the item
 * carries a `requirementId`, and the requirement's stored links are unioned
 * after the hybrid edit candidates by production's `resolveChangeSeeds`.
 *
 * WHICH links: the held-out items are not tracked requirements, so they have no
 * stored links of their own. A2 gives each one the links METIS writes for every
 * tracked requirement with no model and no person: the traceability mapper's
 * `semantic` links ({@link corpusMapperSearcher}). That mapper searches the same
 * index A0 does, so A2 measures the channel on AUTOMATIC links only. Links a
 * person confirmed (`manual`) or the code agent cited (#1755's A3) are not in
 * this corpus and are not measured here.
 *
 * The only difference from A0 is the links: the same extractor, the same
 * changes, the same hybrid search. (A run started from `requirementIds` reads a
 * requirement as one change; the union is the same code.)
 */
export function createA2Arm(deps: ArmDeps): LocalizationArm {
  const { search } = deps;
  const a0 = createA0Arm(deps);
  const mapper = corpusMapperSearcher(search);
  const fileSymbols = new WeakMap<LocalizationCorpus, StoredLinkDeps["loadFileSymbols"]>();
  return {
    id: "A2",
    label: "A2 — A0 plus stored requirement links (mapper-written semantic links), no model",
    configuration: {
      ...a0.configuration,
      stage: "resolveChangeSeeds + stored-link channel (IMPACT_STORED_LINK_SEEDS, #1754)",
      links: `mapRequirementToCode semantic links: top ${DEFAULT_TOP_K}, relative confidence ≥ ${RELATIVE_MIN_CONFIDENCE}`,
    },
    async localize(item, corpus) {
      if (!fileSymbols.has(corpus)) fileSymbols.set(corpus, corpusFileSymbols(corpus));
      const loadFileSymbols = fileSymbols.get(corpus)!;
      const changes = extractChangesByShape(requirementText(item));
      const seedings: SeedingFiles[] = [];
      for (const repo of corpus.manifest.repos) {
        const links: StoredLinkRow[] = (
          await mapRequirementToCode(
            { id: item.id, title: item.title, body: item.text },
            repo.name,
            {},
            { searcher: mapper },
          )
        ).map((m) => ({
          codeSymbolId: m.codeSymbolId,
          filePath: m.filePath,
          startLine: m.startLine,
          endLine: m.endLine,
          confidence: m.confidence,
          source: "semantic",
        }));
        for (const change of changes) {
          const seeds = await resolveChangeSeeds({ ...change, requirementId: item.id }, repo.name, {
            searcher: search.searcher,
            loadSymbols: search.loadSymbols,
            loadWriterIds: search.loadWriterIds,
            storedLinks: { loadLinks: async () => links, loadFileSymbols },
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

/**
 * A4 — A0 plus the additive LLM edit-candidate check (#1756): production's
 * `verifyEditCandidates` over the hybrid file pool, with the line check run
 * against the corpus's symbol rows, folded in by `applyEditVerification`. Every
 * A0 edit candidate stays; a verified promotion is appended after them. The
 * files the model named are reported for graph resolution.
 */
export function createA4Arm(deps: ArmDeps): LocalizationArm {
  const { search, provider } = deps;
  if (!provider) {
    throw new Error(
      "arm A4 calls a model: it needs a live, metered provider (AI_PROVIDER and its key)",
    );
  }
  const a0 = createA0Arm(deps);
  const fileSymbols = new WeakMap<LocalizationCorpus, StoredLinkDeps["loadFileSymbols"]>();
  return {
    id: "A4",
    label: `A4 — A0 plus the LLM edit-candidate check (${provider.key}/${provider.model})`,
    configuration: {
      ...a0.configuration,
      stage: "resolveChangeSeeds + verifyEditCandidates (IMPACT_LLM_EDIT_VERIFY, #1756)",
      poolFiles: VERIFY_POOL_FILES,
      maxPromotions: MAX_PROMOTIONS,
      lineCheck: "inside a symbol of the file (corpus symbol rows)",
      provider: provider.key,
      model: provider.model,
      llm: true,
    },
    async localize(item, corpus) {
      if (!fileSymbols.has(corpus)) fileSymbols.set(corpus, corpusFileSymbols(corpus));
      const loadFileSymbols = fileSymbols.get(corpus)!;
      const changes = extractChangesByShape(requirementText(item));
      const seedings: SeedingFiles[] = [];
      const named: string[] = [];
      for (const repo of corpus.manifest.repos) {
        for (const change of changes) {
          const seeds = await resolveChangeSeeds(change, repo.name, {
            searcher: search.searcher,
            loadSymbols: search.loadSymbols,
            loadWriterIds: search.loadWriterIds,
            filePoolSize: VERIFY_POOL_FILES,
          });
          const verification = await verifyEditCandidates({
            requirementText: requestGateText(change).ask,
            pool: seeds.filePool ?? [],
            provider,
            lineCheck: graphLineCheck(loadFileSymbols, repo.name),
          });
          const verified = applyEditVerification(seeds, verification);
          const key = (m: { filePath: string }) => fileKey(repo.name, m.filePath);
          named.push(...verification.namedFiles.map((f) => fileKey(repo.name, f)));
          seedings.push({
            edit: uniqueInOrder(verified.editCandidates.map(key)),
            other: uniqueInOrder([...verified.related, ...verified.schemaSeeds].map(key)),
          });
        }
      }
      return { ...mergeSeedings(seedings), llmNamedFiles: uniqueInOrder(named) };
    },
  };
}

/** Arms by id. Later issues of epic #1751 add theirs here. */
export const ARM_FACTORIES: Record<string, (deps: ArmDeps) => LocalizationArm> = {
  A0: createA0Arm,
  A2: createA2Arm,
  A4: createA4Arm,
};

/** The arms issues #1754–#1761 will add; named so a request for one fails with its issue. */
export const PLANNED_ARMS: Record<string, string> = {
  A3: "#1755 analysis-agent citations",
  A5: "#1757 adaptive cap",
  A6: "#1758 summaries",
  A7: "#1759 agentic seeder",
  A8: "#1760 BRD citations",
  A9: "#1761 LLM extractor",
};

/**
 * Parse `--arms A0,A4` (default `A0`). A0 is always included and always first:
 * every other arm is reported as a paired comparison against it.
 */
export function parseArmIds(argv: readonly string[]): string[] {
  const i = argv.indexOf("--arms");
  const raw = i >= 0 ? (argv[i + 1] ?? "") : "";
  const ids = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return ["A0", ...ids.filter((id) => id !== "A0")].filter((id, n, all) => all.indexOf(id) === n);
}

/** Build the requested arms; an unknown or not-yet-built arm throws, naming its issue. */
export function buildArms(ids: readonly string[], deps: ArmDeps): LocalizationArm[] {
  return ids.map((id) => {
    const factory = ARM_FACTORIES[id];
    if (factory) return factory(deps);
    const planned = PLANNED_ARMS[id];
    throw new Error(
      planned
        ? `arm ${id} (${planned}) is not built yet; it plugs in through ARM_FACTORIES in its own issue`
        : `unknown arm ${JSON.stringify(id)}; known: ${Object.keys(ARM_FACTORIES).join(", ")}`,
    );
  });
}
