/**
 * #1818 — arm A7: the SHIPPED order of `IMPACT_AGENT_SEEDS` (#1759), read from
 * `computeProjectImpact`.
 *
 * A3A (#1755) measured the code agent's citations as seeds from the eval's own
 * re-creation of the agentic pass. A7 measures what production ships instead:
 *
 *   1. "Evaluate new requirements" — the real `AnalysisOrchestrator.start`,
 *      with the item's text as `extraInstructions` — runs on each repository's
 *      materialized project. Its code agent cites code, synthesis persists the
 *      requirements, and `seedRequirementCodeLinksFromFindings` stores the
 *      citations as `analysis-grounding` rows, all through production code.
 *   2. An impact run about those tracked requirements: one change per
 *      requirement (`loadRequirementChanges`, its own title and body), through
 *      `computeProjectImpact` in every repository, with the stored citations
 *      read back by production's `prismaAgentCitationDeps` and led by
 *      `leadWithAgentCitations` (after the #1756 check and the #1798 re-order,
 *      which are off by default and so off here).
 *
 * Variants, reading ONE analysis per item, repository and run (the first to
 * run it pays; the other reports its cost and time as its own, as A3 and A3A
 * do):
 *
 *   - `A7`  — `IMPACT_AGENT_SEEDS` on: the cited files lead.
 *   - `A7O` — the same impact run with the flag OFF. It separates the lead's
 *     own effect from the change of text (the requirement's wording instead
 *     of the analyst's).
 *
 * The hybrid side is A0's: `resolveChangeSeeds` over the corpus search, injected
 * as the engine's `seedChange`, so A7 against A0 differs only by what
 * production adds. A requirement's citations are files of ITS project, so a
 * change leads only in that repository; in the others it is seeded as A0 would
 * seed its text. An item whose analysis persisted no requirement leaves the
 * analyst nothing tracked to run impact on: it is read as the pasted text
 * (A0's changes, no requirement id) and counted.
 *
 * #1834 — the staleness slice, over the same analyses:
 *
 *   - `A7K`  — no staleness, the stage BEFORE #1832 (the citations' freshness
 *     hidden, so nothing is set aside or ordered by tier). With no re-ingest
 *     every citation is still `unverified`, so A7K must equal A7: the control
 *     that demotion costs nothing when nothing is stale.
 *   - `A7S`  — the item's committed staleness patch applied and re-ingested
 *     (re-validating the citations, #1831), read WITHOUT demotion.
 *   - `A7SD` — the same patched state read WITH demotion (#1832, as shipped).
 *
 * #1899 — A7K equals A7 by construction (no re-ingest, so every citation is
 * `unverified`), so it cannot show what demotion costs when nothing is stale.
 * The production case is a ROUTINE re-ingest, which leaves the citations
 * `fresh` or `moved` and lets the tier sort reorder them:
 *
 *   - `A7R`  — every repository re-ingested at its pinned commit, NO patch,
 *     read with the citations' freshness hidden (the stage before #1832).
 *   - `A7RD` — the same re-ingested state read WITH demotion (#1832).
 *
 * A7S and A7SD read ONE patch cycle per item and run (apply, re-ingest, read
 * both, restore, re-ingest); A7R and A7RD one re-ingest. The hybrid search reads the patched corpus (a
 * renamed file at its new path, re-embedded; a deleted file gone), and so does
 * the stage's graph check, as after a real re-ingest; an edited symbol keeps
 * its vector. A renamed file is scored as the file it was.
 *
 * Schema impact and the blast radius are off (an empty graph): A0 reads
 * neither, and the scorer reads files.
 */
import type { AgentCitationDeps } from "../../impact-analysis/agent-seeder.js";
import {
  resolveChangeSeeds,
  type ChangeSeeds,
  type StoredLinkRow,
} from "../../impact-analysis/change-seeds.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import { extractChangesByShape } from "../../impact-analysis/change-request.js";
import {
  computeProjectImpact,
  InMemoryCodeGraphDataSource,
} from "../../impact-analysis/impact-analysis-engine.js";
import {
  corpusFileSymbols,
  createA0Arm,
  mergeSeedings,
  requirementText,
  uniqueInOrder,
  type AnalysisPassResult,
  type ArmDeps,
  type ArmOutput,
  type LocalizationArm,
  type SeedingFiles,
} from "./arm-core.js";
import { ANALYSIS_PASS_GROUP } from "./agent-env.js";
import { fileKey, type LocalizationCorpus, type LocalizationItem } from "./corpus.js";
import type { AgentRunStats, CitationFreshnessCounts } from "./scorer.js";
import type { CorpusSearch } from "./search.js";
import {
  emptyTally,
  patchedFileSymbols,
  patchedGraphFiles,
  patchedSymbolRows,
  tallyFreshness,
  unrenamedFiles,
  withoutFreshness,
  type StalenessOp,
} from "./staleness.js";

/** A7's variants. */
export interface AnalysisVariant {
  id: "A7" | "A7O" | "A7K" | "A7S" | "A7SD" | "A7R" | "A7RD";
  /** `IMPACT_AGENT_SEEDS`: the stored citations lead the files to edit. */
  agentSeeds: boolean;
  /** #1834 — read after the item's committed staleness patch is applied and re-ingested. */
  stale: boolean;
  /** #1834 — the stage demotes stale citations (#1832, shipped); false hides their freshness. */
  demote: boolean;
  /**
   * #1899 — a staleness variant's cycle applies the item's committed patch;
   * false (A7R, A7RD): a no-op re-ingest at the pinned commit.
   */
  patch: boolean;
}

export const ANALYSIS_VARIANTS: Readonly<Record<AnalysisVariant["id"], AnalysisVariant>> = {
  A7: { id: "A7", agentSeeds: true, stale: false, demote: true, patch: false },
  A7O: { id: "A7O", agentSeeds: false, stale: false, demote: true, patch: false },
  A7K: { id: "A7K", agentSeeds: true, stale: false, demote: false, patch: false },
  A7S: { id: "A7S", agentSeeds: true, stale: true, demote: false, patch: true },
  A7SD: { id: "A7SD", agentSeeds: true, stale: true, demote: true, patch: true },
  A7R: { id: "A7R", agentSeeds: true, stale: true, demote: false, patch: false },
  A7RD: { id: "A7RD", agentSeeds: true, stale: true, demote: true, patch: false },
};

/** The arms that run "Evaluate new requirements": the CLI materializes their database. */
export const ANALYSIS_ARM_IDS: ReadonlySet<string> = new Set(Object.keys(ANALYSIS_VARIANTS));

/** The pass group the report reads; defined in `agent-env.ts` so the report needs no engine (#1825). */
export { ANALYSIS_PASS_GROUP };

/** #1834 — the arms that read through the staleness cycle (#1899: the no-op re-ingest's too). */
export const STALENESS_ARM_IDS: ReadonlySet<string> = new Set(
  Object.values(ANALYSIS_VARIANTS)
    .filter((v) => v.stale)
    .map((v) => v.id),
);

/**
 * #1899 — the arms that read after a no-op re-ingest. A patch cycle's restore
 * leaves a citation `moved` back, so these must be read before every patch
 * arm in the same run, and after the unpatched ones (`buildArms`).
 */
export const NOOP_REINGEST_ARM_IDS: ReadonlySet<string> = new Set(
  Object.values(ANALYSIS_VARIANTS)
    .filter((v) => v.stale && !v.patch)
    .map((v) => v.id),
);

/**
 * #1834 — the arms that read stored citations WITHOUT a patch. A patch cycle
 * re-validates every citation of the repository, so these must be read before
 * any staleness arm in the same run (`buildArms` refuses another order).
 */
export const UNPATCHED_CITATION_ARM_IDS: ReadonlySet<string> = new Set(
  Object.values(ANALYSIS_VARIANTS)
    .filter((v) => v.agentSeeds && !v.stale)
    .map((v) => v.id),
);

/** One item's analyses (one per repository, in manifest order), and what they cost. */
interface SharedAnalyses {
  results: AnalysisPassResult[];
  /** Null when an analysis made an unpriced call. */
  costUsd: number | null;
  seconds: number;
}

/** One store per pass function: the variants built from the same deps share it. */
const sharedAnalyses = new WeakMap<object, Map<string, Promise<SharedAnalyses>>>();

/** #1834 — one patch cycle's (#1899: or no-op re-ingest's) two readings (without and with demotion). */
interface StaleCycle {
  keep: ImpactReading;
  demote: ImpactReading;
  /** The cited files (patched paths) and the ones the patched graph lacks. */
  citedFiles: number;
  unresolvedFiles: number;
  tally: ReturnType<typeof emptyTally>;
  seconds: number;
}

/** One store per staleness IO: A7S and A7SD built from the same deps share a cycle. */
const sharedCycles = new WeakMap<object, Map<string, Promise<StaleCycle>>>();

/** No graph: the blast radius and the structural twins are not read (A0 reads neither). */
const NO_GRAPH = new InMemoryCodeGraphDataSource([], []);

/** One impact reading of an item's changes, across the corpus's repositories. */
interface ImpactReading {
  seedings: SeedingFiles[];
  /** Files the code-agent channel put among the files to edit (`<repo>:<path>`). */
  led: Set<string>;
  /** Stale citations the stage set aside (`demotedStaleCitations`, #1832). */
  demoted: number;
}

/**
 * Build an A7 variant. Needs `deps.analysis` (the CLI's materialized analysis
 * run and reads), `deps.meter` and `deps.provider` (the analysis model, named
 * in the configuration so a resume on another model is refused); a staleness
 * variant also needs `deps.staleness`.
 */
export function createAnalysisArm(deps: ArmDeps, variant: AnalysisVariant): LocalizationArm {
  const { analysis, meter, provider, search, staleness } = deps;
  if (!analysis || !meter || !provider) {
    throw new Error(
      `arm ${variant.id} runs "Evaluate new requirements": it needs a materialized corpus and a live, metered provider (pnpm eval:materialize <corpus>; AI_PROVIDER and its key)`,
    );
  }
  if (variant.stale && !staleness) {
    throw new Error(
      `arm ${variant.id} reads after a committed staleness patch: it needs the staleness cycle (server/scripts/eval-localization-staleness/)`,
    );
  }
  const now = deps.now ?? Date.now;
  if (!sharedAnalyses.has(analysis.pass)) sharedAnalyses.set(analysis.pass, new Map());
  const store = sharedAnalyses.get(analysis.pass)!;
  if (staleness && !sharedCycles.has(staleness)) sharedCycles.set(staleness, new Map());
  const cycles = staleness ? sharedCycles.get(staleness)! : null;
  const fileSymbols = new WeakMap<LocalizationCorpus, ReturnType<typeof corpusFileSymbols>>();
  const symbolsOf = (corpus: LocalizationCorpus) => {
    if (!fileSymbols.has(corpus)) fileSymbols.set(corpus, corpusFileSymbols(corpus));
    return fileSymbols.get(corpus)!;
  };
  const a0 = createA0Arm(deps);

  /** Run the item's analyses, or reuse the ones another variant ran in this run. */
  async function analysesFor(
    corpus: LocalizationCorpus,
    item: LocalizationItem,
    run: number,
  ): Promise<{ shared: SharedAnalyses; reused: boolean }> {
    const key = [corpus.name, item.id, run].join("\u0000");
    const existing = store.get(key);
    if (existing) return { shared: await existing, reused: true };
    const started = now();
    const spent = meter!.spentUsd();
    const unpriced = meter!.unpricedCalls();
    const running = (async (): Promise<SharedAnalyses> => {
      const results: AnalysisPassResult[] = [];
      // One at a time: one SQLite eval database, and a cost per item the cap can read.
      for (const repo of corpus.manifest.repos) {
        results.push(
          await analysis!.pass({
            corpus: corpus.name,
            repo: repo.name,
            text: requirementText(item),
          }),
        );
      }
      return {
        results,
        costUsd: meter!.unpricedCalls() > unpriced ? null : meter!.spentUsd() - spent,
        seconds: (now() - started) / 1000,
      };
    })();
    store.set(key, running);
    // A failed analysis is not kept: a resume runs it again.
    running.catch(() => store.delete(key));
    return { shared: await running, reused: false };
  }

  /**
   * Impact on the item's changes in every repository. With `citations`, the
   * stored citations lead (`IMPACT_AGENT_SEEDS` on); without, A0's seeding.
   */
  async function readImpact(
    corpus: LocalizationCorpus,
    changes: readonly ChangedRequirement[],
    citations: ((repo: string) => AgentCitationDeps) | null,
    searched: CorpusSearch = search,
  ): Promise<ImpactReading> {
    const seedings: SeedingFiles[] = [];
    const led = new Set<string>();
    let demoted = 0;
    for (const repo of corpus.manifest.repos) {
      const key = (filePath: string) => fileKey(repo.name, filePath);
      for (const change of changes) {
        let seeded: ChangeSeeds | null = null;
        const result = await computeProjectImpact(change, repo.name, {
          mapRequirement: async () => {
            throw new Error("A7 seeds with the split seeding (seedChange)");
          },
          seedChange: async (c, projectId) =>
            (seeded = await resolveChangeSeeds(c, projectId, {
              searcher: searched.searcher,
              loadSymbols: searched.loadSymbols,
              loadWriterIds: searched.loadWriterIds,
            })),
          ...(citations ? { agentSeeds: citations(repo.name) } : {}),
          dataSourceFor: () => NO_GRAPH,
          includeSchemaImpact: false,
        });
        demoted += result.seedEvidence?.agentCitations?.demotedStaleCitations ?? 0;
        const evidence = result.seedEvidence?.editCandidates;
        // The engine's edit order: the evidence's when a stage beyond the
        // seeding ran (the UI reads it), else the seeding's own.
        const edit = evidence
          ? evidence.map((e) => e.filePath)
          : uniqueInOrder(
              (seeded as ChangeSeeds | null)?.editCandidates.map((m) => m.filePath) ?? [],
            );
        for (const e of evidence ?? []) {
          if (e.channels.includes("code-agent")) led.add(key(e.filePath));
        }
        seedings.push({
          edit: edit.map(key),
          other: uniqueInOrder(
            result.affectedSymbols.filter((s) => s.relation !== "direct").map((s) => s.filePath),
          ).map(key),
        });
      }
    }
    return { seedings, led, demoted };
  }

  /** The stored citations' files (`<repo>:<path>`) of the item's requirements. */
  async function citedFilesOf(
    corpus: LocalizationCorpus,
    shared: SharedAnalyses,
    tally?: ReturnType<typeof emptyTally>,
  ): Promise<Set<string>> {
    const cited = new Set<string>();
    for (const [i, repo] of corpus.manifest.repos.entries()) {
      for (const requirementId of shared.results[i]?.requirementIds ?? []) {
        const links = await analysis!.loadCitations(requirementId, corpus.name, repo.name);
        if (tally) tallyFreshness(links, tally);
        for (const link of links) cited.add(fileKey(repo.name, link.filePath));
      }
    }
    return cited;
  }

  /** The stage's citation reads in one repository, demoting or not. */
  const citationDeps =
    (
      corpus: LocalizationCorpus,
      demote: boolean,
      loadFileSymbols: AgentCitationDeps["loadFileSymbols"],
    ) =>
    (repo: string): AgentCitationDeps => {
      const load = (requirementId: string): Promise<StoredLinkRow[]> =>
        analysis!.loadCitations(requirementId, corpus.name, repo);
      return {
        loadCitations: demote ? (id) => load(id) : withoutFreshness((id) => load(id)),
        loadFileSymbols,
      };
    };

  /** The item's committed patch (#1834), or none for a no-op re-ingest (#1899). */
  const opsOf = (corpus: LocalizationCorpus, item: LocalizationItem): readonly StalenessOp[] =>
    variant.patch ? staleness!.opsFor(corpus.name, item.id) : [];

  /** #1834 — the item's patch cycle: both staleness readings, or the other variant's. */
  async function cycleFor(
    corpus: LocalizationCorpus,
    item: LocalizationItem,
    run: number,
    shared: SharedAnalyses,
    changes: readonly ChangedRequirement[],
  ): Promise<{ cycle: StaleCycle; reused: boolean }> {
    // #1899 — a patch cycle and a no-op re-ingest are separate cycles.
    const key = [corpus.name, item.id, run, variant.patch ? "patch" : "noop"].join("\u0000");
    const existing = cycles!.get(key);
    if (existing) return { cycle: await existing, reused: true };
    const ops = opsOf(corpus, item);
    const started = now();
    // The search a re-ingest would leave: a renamed file at its new path, a deleted one gone.
    // A no-op re-ingest leaves the corpus as it is: the arm's own search.
    const running = variant.patch
      ? (async () => {
          const patched = await staleness!.searchFor(patchedSymbolRows(corpus.symbols, ops));
          return staleness!.withPatch(corpus.name, ops, () => readCycle(patched));
        })()
      : staleness!.withReingest(corpus.name, () => readCycle(search));
    async function readCycle(patched: CorpusSearch): Promise<StaleCycle> {
      const tally = emptyTally();
      const cited = await citedFilesOf(corpus, shared, tally);
      const graph = patchedGraphFiles(corpus.graphFiles, ops);
      const loadFileSymbols = patchedFileSymbols(symbolsOf(corpus), ops);
      const keep = await readImpact(
        corpus,
        changes,
        citationDeps(corpus, false, loadFileSymbols),
        patched,
      );
      const demote = await readImpact(
        corpus,
        changes,
        citationDeps(corpus, true, loadFileSymbols),
        patched,
      );
      return {
        keep,
        demote,
        citedFiles: cited.size,
        unresolvedFiles: [...cited].filter((f) => !graph.has(f)).length,
        tally,
        seconds: 0,
      };
    }
    const timed = running.then((c) => ({
      ...c,
      seconds: (now() - started) / 1000,
    }));
    cycles!.set(key, timed);
    // A failed cycle is not kept: a resume runs it again.
    timed.catch(() => cycles!.delete(key));
    return { cycle: await timed, reused: false };
  }

  const stage = (): string => {
    if (!variant.agentSeeds) {
      return "computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS off (#1818 control)";
    }
    const demotion = variant.demote
      ? "stale citations demoted (#1832, as shipped)"
      : "the citations' freshness hidden: the stage before #1832 (#1834 control)";
    if (variant.stale && !variant.patch) {
      return `computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS on, after a no-op re-ingest at the pinned commit (#1899); ${demotion}`;
    }
    return variant.stale
      ? `computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS on, after the item's staleness patch was re-ingested; ${demotion}`
      : variant.demote
        ? "computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS on (#1759, #1818)"
        : `computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS on; ${demotion}`;
  };

  return {
    id: variant.id,
    label:
      `${variant.id} — "Evaluate new requirements", then impact on its requirements ` +
      `with IMPACT_AGENT_SEEDS ${variant.agentSeeds ? "on" : "off"}` +
      (variant.stale
        ? `, after ${variant.patch ? "a staleness patch" : "a no-op re-ingest"}, ${variant.demote ? "demoting" : "not demoting"} stale citations`
        : "") +
      (variant.agentSeeds && !variant.stale && !variant.demote ? ", freshness hidden" : "") +
      ` (${provider.key}/${provider.model})`,
    configuration: {
      ...a0.configuration,
      stage: stage(),
      analysis:
        'AnalysisOrchestrator.start: agentKeys ["code"], the item text as extraInstructions, no clarification, no web research; one analysis per repository',
      citations:
        "seedRequirementCodeLinksFromFindings rows (analysis-grounding), read by prismaAgentCitationDeps",
      changes:
        "loadRequirementChanges: one change per persisted requirement, in every repository; the item text (A0's changes) when none was persisted",
      order: !variant.agentSeeds
        ? "the hybrid candidates (A0's seeding of the requirement's text)"
        : variant.demote
          ? "leadWithAgentCitations: stale citations set aside; cited files first (freshness tier, then confidence, then citation order), at most 5; then the hybrid candidates; at most 5 more cited files"
          : "leadWithAgentCitations with freshness hidden: cited files first (confidence, then citation order), at most 5; then the hybrid candidates; at most 5 more cited files",
      sharedAnalysis: "the A7 variants read one analysis per item, repository and run",
      ...(variant.stale && !variant.patch
        ? {
            staleness:
              "no patch: every repository of the corpus re-ingested incrementally at its pinned commit (re-validating the citations, #1831, as a routine re-ingest does), then read; nothing to restore; A7R and A7RD read one re-ingest per item and run (#1899)",
          }
        : {}),
      ...(variant.stale && variant.patch
        ? {
            staleness:
              "the item's committed patch (edit one function, rename one file, delete one file) applied to the materialized clone and committed, re-ingested incrementally (re-validating the citations, #1831), read, then restored and re-ingested; A7S and A7SD read one cycle per item and run",
            stalenessPatchSets: staleness!.patchSetDigest,
            stalenessScoring:
              "the hybrid search and the stage's graph check read the patched rows (a renamed file at its new path, re-embedded; a deleted file gone; an edited symbol keeps its vector); a renamed file is scored as the file it was",
          }
        : {}),
      llmStages: "none in the impact run (#1756, #1798 and the table stages are off by default)",
      provider: provider.key,
      model: provider.model,
      llm: true,
    },
    async localize(item, corpus, context): Promise<ArmOutput> {
      const run = context?.run ?? 1;
      const { shared, reused } = await analysesFor(corpus, item, run);
      const requirementIds = shared.results.flatMap((r) => r.requirementIds);
      const tracked = await analysis!.loadRequirementChanges(requirementIds);
      const changes = tracked.length > 0 ? tracked : extractChangesByShape(requirementText(item));
      const base: Omit<AgentRunStats, "citedFiles" | "unresolvedFiles"> = {
        passes: shared.results.length,
        // An analysis that persisted no requirement leaves nothing tracked to read.
        unanswered: shared.results.filter((r) => r.requirementIds.length === 0).length,
        toolCalls: 0,
        passGroup: ANALYSIS_PASS_GROUP,
        passIds: shared.results.map((r) => r.analysisId),
      };
      const reusedAnalysis = reused
        ? { reusedCostUsd: shared.costUsd, reusedSeconds: shared.seconds }
        : {};

      if (variant.stale) {
        const ops = opsOf(corpus, item);
        const { cycle, reused: reusedCycle } = await cycleFor(corpus, item, run, shared, changes);
        const reading = variant.demote ? cycle.demote : cycle.keep;
        const merged = mergeSeedings(reading.seedings);
        const freshness: CitationFreshnessCounts = {
          ...cycle.tally,
          demoted: reading.demoted,
        };
        return {
          rankedFiles: unrenamedFiles(merged.rankedFiles, ops),
          editCandidateFiles: unrenamedFiles(merged.editCandidateFiles, ops),
          llmNamedFiles: unrenamedFiles([...reading.led], ops),
          agent: {
            ...base,
            citedFiles: cycle.citedFiles,
            unresolvedFiles: cycle.unresolvedFiles,
            citationFreshness: freshness,
          },
          ...(reused || reusedCycle
            ? {
                reusedCostUsd: reused ? shared.costUsd : 0,
                reusedSeconds: (reused ? shared.seconds : 0) + (reusedCycle ? cycle.seconds : 0),
              }
            : {}),
        };
      }

      // What the analyses stored, for the report: every cited file, and the
      // ones the code graph does not hold (the stage drops those).
      const citedFiles = await citedFilesOf(corpus, shared);
      const reading = await readImpact(
        corpus,
        changes,
        variant.agentSeeds ? citationDeps(corpus, variant.demote, symbolsOf(corpus)) : null,
      );
      const resolved = [...citedFiles].filter((f) => corpus.graphFiles.has(f)).length;
      return {
        ...mergeSeedings(reading.seedings),
        ...(variant.agentSeeds ? { llmNamedFiles: [...reading.led] } : {}),
        agent: {
          ...base,
          citedFiles: citedFiles.size,
          unresolvedFiles: citedFiles.size - resolved,
        },
        ...reusedAnalysis,
      };
    },
  };
}

/** A7 — the shipped order: "Evaluate new requirements", then impact with IMPACT_AGENT_SEEDS on (#1818). */
export function createA7Arm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7);
}

/** A7O — the same impact run with the flag off: the control for the change of text (#1818). */
export function createA7OArm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7O);
}

/** A7K — A7 with the citations' freshness hidden, no staleness: must equal A7 (#1834). */
export function createA7KArm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7K);
}

/** A7S — after the item's staleness patch, without demotion (#1834). */
export function createA7SArm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7S);
}

/** A7SD — after the item's staleness patch, with #1832's demotion (#1834). */
export function createA7SDArm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7SD);
}

/** A7R — after a no-op re-ingest, freshness hidden: the stage before #1832 (#1899). */
export function createA7RArm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7R);
}

/** A7RD — after a no-op re-ingest, with #1832's demotion (#1899). */
export function createA7RDArm(deps: ArmDeps): LocalizationArm {
  return createAnalysisArm(deps, ANALYSIS_VARIANTS.A7RD);
}
