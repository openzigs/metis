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
 * Schema impact and the blast radius are off (an empty graph): A0 reads
 * neither, and the scorer reads files.
 */
import { resolveChangeSeeds, type ChangeSeeds } from "../../impact-analysis/change-seeds.js";
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
import { fileKey, type LocalizationCorpus, type LocalizationItem } from "./corpus.js";
import type { AgentRunStats } from "./scorer.js";

/** A7's variants. */
export interface AnalysisVariant {
  id: "A7" | "A7O";
  /** `IMPACT_AGENT_SEEDS`: the stored citations lead the files to edit. */
  agentSeeds: boolean;
}

export const ANALYSIS_VARIANTS: Readonly<Record<AnalysisVariant["id"], AnalysisVariant>> = {
  A7: { id: "A7", agentSeeds: true },
  A7O: { id: "A7O", agentSeeds: false },
};

/** The arms that run "Evaluate new requirements": the CLI materializes their database. */
export const ANALYSIS_ARM_IDS: ReadonlySet<string> = new Set(Object.keys(ANALYSIS_VARIANTS));

/** The pass group the report reads: A7 and A7O must read the same analyses. */
export const ANALYSIS_PASS_GROUP = "analysis";

/** One item's analyses (one per repository, in manifest order), and what they cost. */
interface SharedAnalyses {
  results: AnalysisPassResult[];
  /** Null when an analysis made an unpriced call. */
  costUsd: number | null;
  seconds: number;
}

/** One store per pass function: A7 and A7O built from the same deps share it. */
const sharedAnalyses = new WeakMap<object, Map<string, Promise<SharedAnalyses>>>();

/** No graph: the blast radius and the structural twins are not read (A0 reads neither). */
const NO_GRAPH = new InMemoryCodeGraphDataSource([], []);

/**
 * Build an A7 variant. Needs `deps.analysis` (the CLI's materialized analysis
 * run and reads), `deps.meter` and `deps.provider` (the analysis model, named
 * in the configuration so a resume on another model is refused).
 */
export function createAnalysisArm(deps: ArmDeps, variant: AnalysisVariant): LocalizationArm {
  const { analysis, meter, provider, search } = deps;
  if (!analysis || !meter || !provider) {
    throw new Error(
      `arm ${variant.id} runs "Evaluate new requirements": it needs a materialized corpus and a live, metered provider (pnpm eval:materialize <corpus>; AI_PROVIDER and its key)`,
    );
  }
  const now = deps.now ?? Date.now;
  if (!sharedAnalyses.has(analysis.pass)) sharedAnalyses.set(analysis.pass, new Map());
  const store = sharedAnalyses.get(analysis.pass)!;
  const fileSymbols = new WeakMap<LocalizationCorpus, ReturnType<typeof corpusFileSymbols>>();
  const a0 = createA0Arm(deps);

  /** Run the item's analyses, or reuse the ones the other variant ran in this run. */
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

  return {
    id: variant.id,
    label:
      `${variant.id} — "Evaluate new requirements", then impact on its requirements ` +
      `with IMPACT_AGENT_SEEDS ${variant.agentSeeds ? "on" : "off"} (${provider.key}/${provider.model})`,
    configuration: {
      ...a0.configuration,
      stage: variant.agentSeeds
        ? "computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS on (#1759, #1818)"
        : "computeProjectImpact on the analysis's requirements, IMPACT_AGENT_SEEDS off (#1818 control)",
      analysis:
        'AnalysisOrchestrator.start: agentKeys ["code"], the item text as extraInstructions, no clarification, no web research; one analysis per repository',
      citations:
        "seedRequirementCodeLinksFromFindings rows (analysis-grounding), read by prismaAgentCitationDeps",
      changes:
        "loadRequirementChanges: one change per persisted requirement, in every repository; the item text (A0's changes) when none was persisted",
      order: variant.agentSeeds
        ? "leadWithAgentCitations: cited files first (confidence, then citation order), at most 5; then the hybrid candidates; at most 5 more cited files"
        : "the hybrid candidates (A0's seeding of the requirement's text)",
      sharedAnalysis: "A7 and A7O read one analysis per item, repository and run",
      llmStages: "none in the impact run (#1756, #1798 and the table stages are off by default)",
      provider: provider.key,
      model: provider.model,
      llm: true,
    },
    async localize(item, corpus, context): Promise<ArmOutput> {
      const run = context?.run ?? 1;
      if (!fileSymbols.has(corpus)) fileSymbols.set(corpus, corpusFileSymbols(corpus));
      const loadFileSymbols = fileSymbols.get(corpus)!;
      const { shared, reused } = await analysesFor(corpus, item, run);
      const requirementIds = shared.results.flatMap((r) => r.requirementIds);
      const tracked = await analysis!.loadRequirementChanges(requirementIds);
      const changes = tracked.length > 0 ? tracked : extractChangesByShape(requirementText(item));

      // What the analyses stored, for the report: every cited file, and the
      // ones the code graph does not hold (the stage drops those).
      const citedFiles = new Set<string>();
      for (const [i, repo] of corpus.manifest.repos.entries()) {
        for (const requirementId of shared.results[i]?.requirementIds ?? []) {
          for (const link of await analysis!.loadCitations(requirementId, corpus.name, repo.name)) {
            citedFiles.add(fileKey(repo.name, link.filePath));
          }
        }
      }

      const seedings: SeedingFiles[] = [];
      const led = new Set<string>();
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
                searcher: search.searcher,
                loadSymbols: search.loadSymbols,
                loadWriterIds: search.loadWriterIds,
              })),
            ...(variant.agentSeeds
              ? {
                  agentSeeds: {
                    loadCitations: (requirementId: string, r: string) =>
                      analysis!.loadCitations(requirementId, corpus.name, r),
                    loadFileSymbols,
                  },
                }
              : {}),
            dataSourceFor: () => NO_GRAPH,
            includeSchemaImpact: false,
          });
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

      const resolved = [...citedFiles].filter((f) => corpus.graphFiles.has(f)).length;
      const stats: AgentRunStats = {
        passes: shared.results.length,
        // An analysis that persisted no requirement leaves nothing tracked to read.
        unanswered: shared.results.filter((r) => r.requirementIds.length === 0).length,
        toolCalls: 0,
        citedFiles: citedFiles.size,
        unresolvedFiles: citedFiles.size - resolved,
        passGroup: ANALYSIS_PASS_GROUP,
        passIds: shared.results.map((r) => r.analysisId),
      };
      return {
        ...mergeSeedings(seedings),
        ...(variant.agentSeeds ? { llmNamedFiles: [...led] } : {}),
        agent: stats,
        ...(reused ? { reusedCostUsd: shared.costUsd, reusedSeconds: shared.seconds } : {}),
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
