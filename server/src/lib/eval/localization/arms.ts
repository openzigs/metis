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
  resolveChangeSeeds,
} from "../../impact-analysis/change-seeds.js";
import { extractChangesByShape } from "../../impact-analysis/change-request.js";
import { DEFAULT_WEIGHTS } from "../../code-graph/hybrid-search.js";
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

/** Arms by id. Later issues of epic #1751 add theirs here. */
export const ARM_FACTORIES: Record<string, (deps: ArmDeps) => LocalizationArm> = {
  A0: createA0Arm,
};

/** The arms issues #1754–#1761 will add; named so a request for one fails with its issue. */
export const PLANNED_ARMS: Record<string, string> = {
  A2: "#1754 stored links",
  A3: "#1755 analysis-agent citations",
  A4: "#1756 rerank-and-verify",
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
