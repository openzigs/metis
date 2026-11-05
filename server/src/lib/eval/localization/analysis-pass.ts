/**
 * #1818 — "Evaluate new requirements" behind arm A7, over a MATERIALIZED corpus
 * (`pnpm eval:materialize`, #1799).
 *
 * Unlike the A3 pass (`agent-pass.ts`), which re-creates the code agent's loop
 * and keeps its citations in memory, this runs the orchestrator itself: the
 * CLI injects `AnalysisOrchestrator.start` with the code agent and the item's
 * text as `extraInstructions`, exactly what the analysis page sends when only
 * the code agent is selected. Its pipeline runs the agentic code pass,
 * synthesis and promotion, and `seedRequirementCodeLinksFromFindings` stores
 * the citations, all in the eval database. This module starts the run, waits
 * for its pipeline to end and reads the requirements it persisted; everything
 * else is production's.
 *
 * A run that ends `failed` or `cancelled` THROWS, so a transient provider
 * fault is not scored as "no requirement": the runner stops, and a resume runs
 * the item again. A completed run that persisted no requirement (promotion
 * blocked, or nothing to promote) is a result, and returns none.
 */
import type { AnalysisPass, AnalysisPassResult } from "./arm-core.js";
import type { MaterializedState } from "./materialize.js";

/** The terminal statuses of an analysis row. */
export const TERMINAL_ANALYSIS_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** How long one analysis may run before the pass gives up on it (and cancels it). */
export const ANALYSIS_TIMEOUT_MS = 8 * 60_000;

export interface AnalysisRunState {
  status: string;
  errorMessage: string | null;
}

export interface MaterializedAnalysisPassDeps {
  /** The materialized state of each corpus the run reads, by corpus name. */
  states: ReadonlyMap<string, MaterializedState>;
  /** `AnalysisOrchestrator.start` for the project, with the text as `extraInstructions`. */
  start: (input: { projectId: string; text: string }) => Promise<{ id: string }>;
  /** The analysis row's status, or null when there is no such row. */
  readState: (analysisId: string) => Promise<AnalysisRunState | null>;
  /** True while the orchestrator's pipeline for the run is still going. */
  isActive: (analysisId: string) => boolean;
  /** Cancel a run that outlived {@link ANALYSIS_TIMEOUT_MS}. */
  cancel: (analysisId: string) => Promise<unknown>;
  /** The requirements the run persisted, in creation order. */
  requirementIds: (analysisId: string) => Promise<string[]>;
  /** Seams for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Wait until the run's row is terminal AND its pipeline has returned: the
 * citations are written after the row's requirements, inside the pipeline.
 */
export async function waitForAnalysis(
  analysisId: string,
  deps: Pick<
    MaterializedAnalysisPassDeps,
    "readState" | "isActive" | "cancel" | "sleep" | "now" | "pollMs" | "timeoutMs"
  >,
): Promise<AnalysisRunState> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeoutMs ?? ANALYSIS_TIMEOUT_MS);
  for (;;) {
    const state = await deps.readState(analysisId);
    if (!state) throw new Error(`analysis ${analysisId} is not in the eval database`);
    if (TERMINAL_ANALYSIS_STATUSES.has(state.status) && !deps.isActive(analysisId)) return state;
    if (now() >= deadline) {
      await deps.cancel(analysisId);
      throw new Error(
        `analysis ${analysisId} did not finish within ${(deps.timeoutMs ?? ANALYSIS_TIMEOUT_MS) / 1000} s (cancelled)`,
      );
    }
    await sleep(deps.pollMs ?? 1000);
  }
}

/** The pass over a materialized corpus. Throws on an unmaterialized corpus or repository. */
export function createMaterializedAnalysisPass(deps: MaterializedAnalysisPassDeps): AnalysisPass {
  return async ({ corpus, repo, text }): Promise<AnalysisPassResult> => {
    const state = deps.states.get(corpus);
    if (!state)
      throw new Error(`${corpus} is not materialized: run pnpm eval:materialize ${corpus}`);
    const materialized = state.repos.find((r) => r.name === repo);
    if (!materialized) throw new Error(`${corpus}: repository ${repo} is not materialized`);
    const { id } = await deps.start({ projectId: materialized.projectId, text });
    const end = await waitForAnalysis(id, deps);
    if (end.status !== "completed") {
      throw new Error(
        `analysis ${id} (${corpus}/${repo}) ended ${end.status}: ${end.errorMessage ?? "no error recorded"}`,
      );
    }
    return { analysisId: id, status: end.status, requirementIds: await deps.requirementIds(id) };
  };
}
