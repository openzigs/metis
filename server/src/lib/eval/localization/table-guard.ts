/**
 * #1786 — the table-precision guard for an arm that changes the SPLIT seeding.
 *
 * `pnpm eval:localization --table-guard` reads table precision on
 * `impact-recall-01-jpetstore`. A0's reading drives `computeProjectImpact`
 * through the injected mapper (`mapRequirementToCode`), the configuration the
 * impact-recall floors were measured on. The #1756 edit-candidate check (arm
 * A4) runs only on a split seeding's file pool, so on the mapper path it never
 * runs and "A4's" reading would be A0's under A4's label.
 *
 * So an arm on the split seeding is measured twice, on the same corpus,
 * provider and run count: the split seeding alone (A0 on that seeding) and the
 * split seeding with the arm's stage. The arm is gated against the first, so a
 * seeding change is never read as the arm's effect.
 *
 * The split seeding searches with production's `HybridCodeSearch` over the
 * fixture's searchable symbols ({@link fixtureSearchRows}), from the corpus's
 * recorded vectors, exactly as the localization arms do ({@link buildCorpusSearch}).
 */
import type { AIProvider } from "../../ai/types.js";
import type { SeedSymbolRow } from "../../impact-analysis/change-seeds.js";
import {
  graphLineCheck,
  verifyEditCandidates,
} from "../../impact-analysis/edit-candidate-verifier.js";
import { rerankEditCandidates } from "../../impact-analysis/edit-candidate-reranker.js";
import type {
  EditCandidateRerankerFn,
  EditCandidateVerifierFn,
} from "../../impact-analysis/impact-analysis-engine.js";
import { embeddableSymbols, type ImpactRecallFixture } from "../impact-recall/fixture.js";
import type {
  ImpactRecallRunSummary,
  RunImpactRecallOptions,
  SplitSeedingOptions,
} from "../impact-recall/runner.js";
import type { LocalizationSymbolRow } from "./corpus.js";
import type { TableGuardMeasurement, TableGuardReading } from "./runner.js";
import type { CorpusSearch } from "./search.js";

/** The seeding A0's own guard reading uses: the mapper path. */
export const MAPPER_SEEDING = "mapper (mapRequirementToCode, BM25; the impact-recall floors' path)";

/**
 * The fixture's searchable symbols as corpus rows, one repository named after
 * the fixture's project. Only `inCorpus` symbols are searchable, as in the
 * fixture's own searchers; each carries the text production embeds for it
 * (`embeddableSymbols`), so the recorded vectors answer.
 */
export function fixtureSearchRows(fixture: ImpactRecallFixture): LocalizationSymbolRow[] {
  const language = new Map(fixture.manifest.codeSymbols.map((s) => [s.id, s.language]));
  return embeddableSymbols(fixture.manifest.codeSymbols).map((s) => ({
    id: s.symbolId,
    repo: fixture.projectId,
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    // Every embeddable symbol is a fixture symbol, so it has a language.
    language: language.get(s.symbolId)!,
    filePath: s.filePath,
    // The fixture's graph places every symbol on lines 1-2 (`toGraphSymbol`).
    startLine: 1,
    endLine: 2,
    embeddingText: s.embeddingText,
  }));
}

/** What a split-seeding guard measurement is given. */
export interface SplitSeedingGuardDeps {
  /** The corpus search over {@link fixtureSearchRows}. */
  search: Pick<CorpusSearch, "searcher" | "loadSymbols">;
  /** The production-configuration options (consumer resolver, live #936 table filter). */
  options: RunImpactRecallOptions;
  /** The arm's stage on top of the split seeding: the edit-candidate check (A4)… */
  editCandidateVerifier?: EditCandidateVerifierFn;
  /** …or #1798's edit re-order (A13). One of the two. */
  editCandidateReranker?: EditCandidateRerankerFn;
  /** `runImpactRecallEvalRepeated`, injected so this module stays free of the corpus I/O. */
  runRepeated: (options: RunImpactRecallOptions) => Promise<ImpactRecallRunSummary>;
  /** Appended to each reading's configuration: the corpus and the provider. */
  describe: (summary: ImpactRecallRunSummary) => string;
}

function measurement(
  summary: ImpactRecallRunSummary,
  describe: SplitSeedingGuardDeps["describe"],
): TableGuardMeasurement {
  return {
    tablePrecision: summary.meanAggregate.tables.macroPrecision,
    runs: summary.runCount,
    configuration: describe(summary),
    seeding: summary.configuration.seeding,
  };
}

/**
 * #1786 — the arm's reading on the split seeding plus its check, with A0 on
 * the split seeding alone as its `baseline`. The baseline runs first, so a
 * run stopped in between still spent nothing on the arm.
 */
export async function measureSplitSeedingGuard(
  deps: SplitSeedingGuardDeps,
): Promise<TableGuardReading> {
  const stage = deps.editCandidateVerifier
    ? { editCandidateVerifier: deps.editCandidateVerifier }
    : deps.editCandidateReranker
      ? { editCandidateReranker: deps.editCandidateReranker }
      : null;
  if (!stage) throw new Error("a split-seeding guard needs the arm's stage: a check or a re-order");
  const split: SplitSeedingOptions = {
    searcher: deps.search.searcher,
    loadSymbols: deps.search.loadSymbols,
  };
  const baseline = await deps.runRepeated({ ...deps.options, splitSeeding: split });
  const checked = await deps.runRepeated({
    ...deps.options,
    splitSeeding: { ...split, ...stage },
  });
  return {
    measured: true,
    ...measurement(checked, deps.describe),
    baseline: measurement(baseline, deps.describe),
  };
}

/**
 * Every fixture symbol in the given files (not only the searchable ones): the
 * graph-membership lookup the check's line test reads, as production's
 * `prismaFileSymbolLoader` reads every `CodeSymbol` of a file.
 */
export function fixtureFileSymbols(
  fixture: ImpactRecallFixture,
): (filePaths: string[], projectId: string) => Promise<SeedSymbolRow[]> {
  return async (filePaths, projectId) => {
    if (projectId !== fixture.projectId) return [];
    const wanted = new Set(filePaths);
    return fixture.manifest.codeSymbols
      .filter((s) => wanted.has(s.filePath))
      .map((s) => ({
        id: s.id,
        qualifiedName: s.qualifiedName,
        filePath: s.filePath,
        kind: s.kind,
        language: s.language,
        startLine: 1,
        endLine: 2,
        signature: null,
      }));
  };
}

/**
 * The #1756 check as the route wires it (`editCandidateVerifierDep`): production's
 * `verifyEditCandidates`, its line test against the fixture's graph.
 */
export function fixtureEditCandidateVerifier(
  fixture: ImpactRecallFixture,
  provider: AIProvider,
): EditCandidateVerifierFn {
  const loadFileSymbols = fixtureFileSymbols(fixture);
  return ({ requirementText, pool, projectId }) =>
    verifyEditCandidates({
      requirementText,
      pool,
      provider,
      lineCheck: graphLineCheck(loadFileSymbols, projectId),
    });
}

/**
 * #1798 — the edit re-order as the route wires it (`editCandidateRerankerDep`):
 * production's `rerankEditCandidates`, its line test against the fixture's graph.
 */
export function fixtureEditCandidateReranker(
  fixture: ImpactRecallFixture,
  provider: AIProvider,
): EditCandidateRerankerFn {
  const loadFileSymbols = fixtureFileSymbols(fixture);
  return ({ requirementText, pool, projectId }) =>
    rerankEditCandidates({
      requirementText,
      pool,
      provider,
      lineCheck: graphLineCheck(loadFileSymbols, projectId),
    });
}
