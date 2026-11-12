/**
 * #1753 — the arms the localization eval compares, chosen by EXPLICIT runner
 * options, never by ambient `IMPACT_LLM_*` variables: `eval-impact-recall.ts`
 * builds its LLM stages itself and reads no such variable
 * (docs/IMPACT_ANALYSIS_LLM_STAGES.md), so an environment flag would change
 * production behaviour without the harness being able to tell two arms apart.
 *
 * A0 is the shipped seeding and this issue's deliverable. Each later arm of
 * epic #1751 (A2 stored links #1754, A3 analysis-agent citations #1755, A4
 * rerank-and-verify #1756, A5 adaptive cap #1757, A6 summaries #1758, A7 the
 * shipped agentic seeder #1759/#1818, A8 BRD citations #1760, A9 LLM extractor #1761) adds a factory
 * to {@link ARM_FACTORIES} in its own PR; until then asking for it fails loudly.
 */
import {
  MAX_EDIT_FILES,
  MIN_FILE_SHARE,
  REQUEST_COSINE_MARGIN,
  VERIFY_POOL_FILES,
  rankEditCandidatesPerRequest,
  resolveChangeSeeds,
  type RequestRankingBasis,
  type RequestSeeding,
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
import {
  applyEditRerank,
  MAX_RERANK_PICKS,
  RERANK_MODEL_WEIGHT,
  RERANK_RRF_K,
  rerankEditCandidates,
} from "../../impact-analysis/edit-candidate-reranker.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import {
  DEFAULT_TOP_K,
  mapRequirementToCode,
  RELATIVE_MIN_CONFIDENCE,
  type CodeSymbolSearcher,
} from "../../traceability/requirement-code-mapping.js";
import { fileKey, type LocalizationCorpus, type LocalizationItem } from "./corpus.js";
import type { CorpusSearch } from "./search.js";
import { seededRandom } from "./stats.js";
import { createA3AArm, createA3Arm, createA3NArm, createA3PArm } from "./agent-arms.js";
import {
  createA7Arm,
  createA7KArm,
  createA7OArm,
  createA7RArm,
  createA7RDArm,
  createA7SArm,
  createA7SDArm,
  NOOP_REINGEST_ARM_IDS,
  STALENESS_ARM_IDS,
  UNPATCHED_CITATION_ARM_IDS,
} from "./analysis-arms.js";
import {
  corpusFileSymbols,
  createA0Arm,
  mergeSeedings,
  requirementText,
  uniqueInOrder,
  type ArmDeps,
  type ArmOutput,
  type LocalizationArm,
  type SeedingFiles,
} from "./arm-core.js";

// #1810 — the shared contract and helpers live in arm-core.ts (no import cycle
// with agent-arms.ts); re-exported for the modules that import them from here.
export {
  corpusFileSymbols,
  createA0Arm,
  mergeSeedings,
  requirementText,
  type ArmDeps,
  type ArmOutput,
  type LocalizationArm,
  type LocalizeContext,
  type SeedingFiles,
} from "./arm-core.js";

/** The arms that call a model: the CLI builds a live, metered provider only for these. */
export const MODEL_ARMS: ReadonlySet<string> = new Set([
  "A3",
  "A3A",
  "A3N",
  "A3P",
  "A4",
  "A7",
  "A7O",
  "A7K",
  "A7S",
  "A7SD",
  "A7R",
  "A7RD",
  "A13",
  "A13C",
  "A13S",
]);

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
      lineCheck: "inside a named symbol of the file, never its module span (corpus symbol rows)",
      // #1781 — the model names files only by pool index, and every pool file is a
      // code-graph file: this arm's graph resolution cannot be below 1.00.
      graphResolution: "1.00 by construction (pool indices only)",
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

/**
 * A11 — A0 with the edit candidates ranked ONCE per requirement (#1776): every
 * change is seeded in every repository exactly as A0 does, then production's
 * `rankEditCandidatesPerRequest` keeps the requirement's best files (the same
 * cut: {@link MAX_EDIT_FILES} files within {@link MIN_FILE_SHARE} of the single
 * best) and moves the rest to related. Ranked files are merged exactly as A0's
 * ({@link mergeSeedings}), so the paired comparison differs only in WHICH files
 * are edit candidates, not in how seedings are interleaved.
 */
export function createA11Arm(deps: ArmDeps): LocalizationArm {
  const a0 = createA0Arm(deps);
  return {
    id: "A11",
    label: "A11 — A0 with edit candidates ranked once per requirement, no model",
    configuration: {
      ...a0.configuration,
      stage:
        "resolveChangeSeeds + rankEditCandidatesPerRequest (IMPACT_REQUEST_EDIT_RANKING, #1776)",
      editCut: `once per requirement over every change and repository: top ${MAX_EDIT_FILES}, share ≥ ${MIN_FILE_SHARE}`,
    },
    localize: (item, corpus) => localizePerRequest(deps.search, item, corpus, "fused"),
  };
}

/**
 * A12 — A11 on a score that compares across searches (#1784): each edit
 * file's fused-score share of its seeding's best, times that seeding's best
 * vector cosine (`crossSearchScore`), cut at {@link REQUEST_COSINE_MARGIN}
 * below the requirement's best. Everything else is A11's, so A12 against A11
 * isolates the score.
 */
export function createA12Arm(deps: ArmDeps): LocalizationArm {
  const a0 = createA0Arm(deps);
  return {
    id: "A12",
    label: "A12 — A0 with edit candidates ranked once per requirement on a cosine score, no model",
    configuration: {
      ...a0.configuration,
      stage:
        "resolveChangeSeeds + rankEditCandidatesPerRequest(cosine) (IMPACT_REQUEST_EDIT_RANKING, #1784)",
      editCut: `once per requirement over every change and repository: top ${MAX_EDIT_FILES}, (share of seeding best) × seeding best cosine ≥ best − ${REQUEST_COSINE_MARGIN}`,
    },
    localize: (item, corpus) => localizePerRequest(deps.search, item, corpus, "cosine"),
  };
}

/**
 * Every change seeded in every repository exactly as A0 does, then the edit
 * candidates ranked once per requirement on `basis`. Ranked files are merged
 * exactly as A0's ({@link mergeSeedings}), so the paired comparison differs
 * only in WHICH files are edit candidates, not in how seedings are interleaved.
 */
async function localizePerRequest(
  search: CorpusSearch,
  item: LocalizationItem,
  corpus: LocalizationCorpus,
  basis: RequestRankingBasis,
): Promise<ArmOutput> {
  const changes = extractChangesByShape(requirementText(item));
  const seedings: RequestSeeding[] = [];
  for (const repo of corpus.manifest.repos) {
    for (const change of changes) {
      const seeds = await resolveChangeSeeds(change, repo.name, {
        searcher: search.searcher,
        loadSymbols: search.loadSymbols,
        loadWriterIds: search.loadWriterIds,
        editFileScores: true,
      });
      seedings.push({ projectId: repo.name, seeds });
    }
  }
  const ranked = rankEditCandidatesPerRequest(seedings, basis);
  return mergeSeedings(
    ranked.map((seeds, i) => {
      const key = (m: { filePath: string }) => fileKey(seedings[i]!.projectId, m.filePath);
      return {
        edit: uniqueInOrder(seeds.editCandidates.map(key)),
        other: uniqueInOrder([...seeds.related, ...seeds.schemaSeeds].map(key)),
      };
    }),
  );
}

/**
 * #1798 — a seeded shuffle of `n` pool indices (Fisher-Yates over mulberry32),
 * the same for the same `seedText`, so the position-bias reading is
 * reproducible run to run.
 */
export function shuffledPresentation(n: number, seedText: string): number[] {
  // FNV-1a over the text: a 32-bit seed.
  let h = 0x811c9dc5;
  for (const ch of seedText) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const rand = seededRandom(h);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** #1798 — what an A13 variant re-orders, and how its pool is shown. */
interface RerankVariant {
  id: string;
  /** `A0`: each seeding's own edit cut. `A12`: the cosine cut once per request (#1784). */
  base: "A0" | "A12";
  /** Show the pool in a seeded shuffle instead of the deterministic order. */
  shuffled: boolean;
}

/**
 * A13 (#1798) — the LLM re-order of the edit candidates over the hybrid pool,
 * production's `rerankEditCandidates` + `applyEditRerank`, one call per change
 * and repository, the line check run against the corpus's symbol rows. The
 * base order is A0's (`A13`), or A12's cosine ranking (`A13C`); `A13S` is A13
 * with the pool shown in a seeded shuffle, to read whether Recall@5 depends on
 * the order the model is shown. Every deterministic candidate of the base stays
 * an edit candidate; the files the model named are reported for graph
 * resolution.
 */
function createRerankArm(deps: ArmDeps, variant: RerankVariant): LocalizationArm {
  const { search, provider } = deps;
  const weight = deps.rerankWeight ?? RERANK_MODEL_WEIGHT;
  if (!provider) {
    throw new Error(
      `arm ${variant.id} calls a model: it needs a live, metered provider (AI_PROVIDER and its key)`,
    );
  }
  const a0 = createA0Arm(deps);
  const cosine = variant.base === "A12";
  const fileSymbols = new WeakMap<LocalizationCorpus, StoredLinkDeps["loadFileSymbols"]>();
  return {
    id: variant.id,
    label:
      `${variant.id} — ${variant.base} with the LLM re-order of the edit candidates` +
      `${variant.shuffled ? ", pool shown shuffled" : ""} (${provider.key}/${provider.model})`,
    configuration: {
      ...a0.configuration,
      stage:
        `resolveChangeSeeds${cosine ? " + rankEditCandidatesPerRequest(cosine)" : ""}` +
        " + rerankEditCandidates (IMPACT_LLM_EDIT_RERANK, #1798)",
      baseOrder: cosine
        ? "A12: edit candidates ranked once per requirement on the cosine score (#1784)"
        : "A0: each seeding's own edit cut",
      ...(cosine
        ? {
            editCut: `once per requirement over every change and repository: top ${MAX_EDIT_FILES}, (share of seeding best) × seeding best cosine ≥ best − ${REQUEST_COSINE_MARGIN}`,
          }
        : {}),
      poolFiles: VERIFY_POOL_FILES,
      maxPicks: MAX_RERANK_PICKS,
      fusion: `reciprocal rank, k = ${RERANK_RRF_K}, model weight ${weight}; top ${MAX_EDIT_FILES} plus every deterministic candidate`,
      presentation: variant.shuffled
        ? "pool shuffled per change and repository (seeded by the item id)"
        : "pool in the deterministic order",
      lineCheck: "inside a named symbol of the file, never its module span (corpus symbol rows)",
      graphResolution: "1.00 by construction (pool indices only)",
      provider: provider.key,
      model: provider.model,
      llm: true,
    },
    async localize(item, corpus) {
      if (!fileSymbols.has(corpus)) fileSymbols.set(corpus, corpusFileSymbols(corpus));
      const loadFileSymbols = fileSymbols.get(corpus)!;
      const changes = extractChangesByShape(requirementText(item));
      const seedings: RequestSeeding[] = [];
      const changeOf: ChangedRequirement[] = [];
      for (const repo of corpus.manifest.repos) {
        for (const change of changes) {
          const seeds = await resolveChangeSeeds(change, repo.name, {
            searcher: search.searcher,
            loadSymbols: search.loadSymbols,
            loadWriterIds: search.loadWriterIds,
            filePoolSize: VERIFY_POOL_FILES,
            ...(cosine ? { editFileScores: true } : {}),
          });
          seedings.push({ projectId: repo.name, seeds });
          changeOf.push(change);
        }
      }
      const based = cosine
        ? rankEditCandidatesPerRequest(seedings, "cosine")
        : seedings.map((s) => s.seeds);
      const named: string[] = [];
      const files: SeedingFiles[] = [];
      for (const [i, seeds] of based.entries()) {
        const repo = seedings[i]!.projectId;
        const pool = seeds.filePool ?? [];
        const rerank = await rerankEditCandidates({
          requirementText: requestGateText(changeOf[i]!).ask,
          pool,
          provider,
          lineCheck: graphLineCheck(loadFileSymbols, repo),
          ...(variant.shuffled
            ? { presentation: shuffledPresentation(pool.length, `${item.id}|${repo}|${i}`) }
            : {}),
        });
        const reranked = applyEditRerank(seeds, rerank, weight);
        const key = (m: { filePath: string }) => fileKey(repo, m.filePath);
        named.push(...rerank.namedFiles.map((f) => fileKey(repo, f)));
        files.push({
          edit: uniqueInOrder(reranked.editCandidates.map(key)),
          other: uniqueInOrder([...reranked.related, ...reranked.schemaSeeds].map(key)),
        });
      }
      return { ...mergeSeedings(files), llmNamedFiles: uniqueInOrder(named) };
    },
  };
}

/** A13 — A0's order with the LLM re-order (#1798). */
export function createA13Arm(deps: ArmDeps): LocalizationArm {
  return createRerankArm(deps, { id: "A13", base: "A0", shuffled: false });
}

/** A13C — A12's cosine order with the LLM re-order (#1798). */
export function createA13CArm(deps: ArmDeps): LocalizationArm {
  return createRerankArm(deps, { id: "A13C", base: "A12", shuffled: false });
}

/** A13S — A13 with the pool shown in a seeded shuffle: the position-bias reading (#1798). */
export function createA13SArm(deps: ArmDeps): LocalizationArm {
  return createRerankArm(deps, { id: "A13S", base: "A0", shuffled: true });
}

/** Arms by id. Later issues of epic #1751 add theirs here. */
export const ARM_FACTORIES: Record<string, (deps: ArmDeps) => LocalizationArm> = {
  A0: createA0Arm,
  A2: createA2Arm,
  A3: createA3Arm,
  A3A: createA3AArm,
  A3N: createA3NArm,
  A3P: createA3PArm,
  A4: createA4Arm,
  A7: createA7Arm,
  A7O: createA7OArm,
  A7K: createA7KArm,
  A7S: createA7SArm,
  A7SD: createA7SDArm,
  A7R: createA7RArm,
  A7RD: createA7RDArm,
  A11: createA11Arm,
  A12: createA12Arm,
  A13: createA13Arm,
  A13C: createA13CArm,
  A13S: createA13SArm,
};

/** The arms issues #1754–#1761 will add; named so a request for one fails with its issue. */
export const PLANNED_ARMS: Record<string, string> = {
  A5: "#1757 adaptive cap",
  A6: "#1758 summaries",
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

/**
 * Build the requested arms; an unknown or not-yet-built arm throws, naming its issue.
 * #1834 — a staleness arm's patch cycle re-validates every stored citation of
 * the repository, so an arm that reads citations unpatched (A7, A7K) must come
 * before every staleness arm (A7S, A7SD): the runner reads arm by arm.
 * #1899 — a patch cycle's restore leaves a citation `moved` back, so a no-op
 * re-ingest arm (A7R, A7RD) must come before every patch arm too.
 */
export function buildArms(ids: readonly string[], deps: ArmDeps): LocalizationArm[] {
  const firstStale = ids.findIndex((id) => STALENESS_ARM_IDS.has(id));
  const lateUnpatched = ids.find(
    (id, i) => firstStale >= 0 && i > firstStale && UNPATCHED_CITATION_ARM_IDS.has(id),
  );
  if (lateUnpatched) {
    throw new Error(
      `--arms: ${lateUnpatched} reads the stored citations unpatched, so it must come before ${ids[firstStale]}: a staleness arm's patch cycle re-validates every citation of the repository`,
    );
  }
  const firstPatch = ids.findIndex(
    (id) => STALENESS_ARM_IDS.has(id) && !NOOP_REINGEST_ARM_IDS.has(id),
  );
  const lateNoop = ids.find(
    (id, i) => firstPatch >= 0 && i > firstPatch && NOOP_REINGEST_ARM_IDS.has(id),
  );
  if (lateNoop) {
    throw new Error(
      `--arms: ${lateNoop} reads after a no-op re-ingest, so it must come before ${ids[firstPatch]}: a patch cycle's restore leaves a citation moved back`,
    );
  }
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
