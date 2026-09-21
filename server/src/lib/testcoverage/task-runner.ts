/**
 * Test-coverage background task runner — Epic #856 issue #862.
 *
 * Phase 1 scope: orchestrate the run lifecycle (queued → running → completed
 * | failed), persist phase-by-phase progress to `TestCoverageRun.phaseProgress`,
 * and emit lifecycle events through a pluggable emitter so the workbench can
 * subscribe without polling.
 *
 * The matcher/judge/suggestion phases are intentionally stubbed here. The
 * production logic for those phases lands in Phase 2 (#869/#870 etc.); this
 * runner provides the shell those handlers will fill in, with a stable phase
 * naming scheme already exposed to the UI.
 */
import { prisma } from "../prisma.js";
import { TestCoverageIndexer } from "./indexer.js";
import { finaliseCase } from "./normaliser.js";
import { runCoverageScoring } from "./coverage-service.js";
import type { JudgeModelCaller } from "./judge.js";
import type { TestCaseSource, NormalisedTestCase } from "@metis/shared";

export const TEST_COVERAGE_PHASES = [
  "import",
  "index",
  "match",
  "judge",
  "suggest",
  "score",
] as const;
export type TestCoveragePhase = (typeof TEST_COVERAGE_PHASES)[number];

export interface TestCoverageEvent {
  type: "run:queued" | "run:started" | "run:progress" | "run:completed" | "run:failed";
  runId: string;
  projectId: string;
  phase?: TestCoveragePhase;
  detail?: Record<string, unknown>;
  error?: string;
}

export type TestCoverageEmitter = (event: TestCoverageEvent) => void;

const noopEmitter: TestCoverageEmitter = () => {};

export interface RunTestCoverageJobInput {
  runId: string;
  projectId: string;
}

export interface TestCoverageRunnerDeps {
  emitter?: TestCoverageEmitter;
  indexer?: TestCoverageIndexer;
  /** Override for unit tests; defaults to prisma. */
  db?: typeof prisma;
  /** LLM bridge for judge + suggestion phases. When omitted, those phases are skipped. */
  caller?: JudgeModelCaller;
  /** Per-run cost ceiling, defaults to {@link CoverageCostTracker.DEFAULT_BUDGET_CENTS}. */
  budgetCents?: number;
}

/**
 * Execute a single test-coverage run end-to-end. Idempotent: if the run is
 * not in `queued` state we return early without mutating anything. All work
 * is wrapped in a try/catch so the run is always finalised — either as
 * `completed` or `failed` — before the function resolves.
 */
export async function runTestCoverageJob(
  input: RunTestCoverageJobInput,
  deps: TestCoverageRunnerDeps = {},
): Promise<void> {
  const { runId, projectId } = input;
  const emit = deps.emitter ?? noopEmitter;
  const db = deps.db ?? prisma;
  const indexer = deps.indexer ?? new TestCoverageIndexer();

  const existing = await db.testCoverageRun.findUnique({ where: { id: runId } });
  if (!existing) return;
  if (existing.status !== "queued") return;

  const progress: Record<TestCoveragePhase, "pending" | "running" | "done" | "skipped"> = {
    import: "pending",
    index: "pending",
    match: "pending",
    judge: "pending",
    suggest: "pending",
    score: "pending",
  };

  await db.testCoverageRun.update({
    where: { id: runId },
    data: {
      status: "running",
      startedAt: new Date(),
      phaseProgress: JSON.stringify(progress),
    },
  });
  emit({ type: "run:started", runId, projectId });

  // Set true when an LLM phase was hard-stopped by the per-run token budget
  // (Epic #880 / #883). Surfaced to the UI via the run status + completion event.
  let budgetExceeded = false;

  try {
    // ---- import ---------------------------------------------------------
    await advance("import", "running");
    const cases = await db.testCaseDoc.findMany({
      where: { projectId },
      select: {
        id: true,
        contentHash: true,
        title: true,
        preconditions: true,
        stepsJson: true,
        expected: true,
        priority: true,
        tags: true,
        externalId: true,
        source: true,
      },
    });
    await advance("import", "done", { count: cases.length });

    // ---- index ----------------------------------------------------------
    await advance("index", "running");
    if (cases.length > 0) {
      const indexable = cases.map((c) => ({
        docId: c.id,
        contentHash: c.contentHash,
        case: hydrateCase(c),
      }));
      await indexer.index(projectId, indexable);
    }
    await advance("index", "done", { count: cases.length });

    // ---- match / judge / suggest ----------------------------------------
    if (deps.caller) {
      await advance("match", "running");
      const report = await runCoverageScoring(
        { runId, projectId, userId: existing.createdById },
        {
          db,
          caller: deps.caller,
          budgetCents: deps.budgetCents,
          emit: (event) => {
            // Map service-level events onto runner phases.
            if (event.phase === "match" && event.state === "done") {
              progress.match = "done";
            } else if (event.phase === "judge") {
              progress.judge = event.state === "running" ? "running" : "done";
            } else if (event.phase === "suggest") {
              progress.suggest = event.state === "running" ? "running" : "done";
            }
            void db.testCoverageRun
              .update({
                where: { id: runId },
                data: { phaseProgress: JSON.stringify(progress) },
              })
              .catch(() => {});
            emit({
              type: "run:progress",
              runId,
              projectId,
              phase: event.phase as TestCoveragePhase,
              detail: event.detail,
            });
          },
        },
      );
      await advance("match", "done", { ...report.matcher });
      await advance("judge", "done", { ...report.judge });
      await advance("suggest", "done", { ...report.suggestions });
      budgetExceeded = report.budgetExceeded;
    } else {
      // No caller wired — skip downstream phases. Same behaviour as Phase 1.
      await advance("match", "skipped");
      await advance("judge", "skipped");
      await advance("suggest", "skipped");
    }

    // ---- score ----------------------------------------------------------
    await advance("score", "running");
    const [mappingCount, gapCount, suggestionCount] = await Promise.all([
      db.coverageMapping.count({ where: { runId } }),
      db.gapItem.count({ where: { runId } }),
      db.suggestion.count({ where: { runId } }),
    ]);
    await advance("score", "done", {
      mappings: mappingCount,
      gaps: gapCount,
      suggestions: suggestionCount,
    });

    await db.testCoverageRun.update({
      where: { id: runId },
      data: {
        status: budgetExceeded ? "budget_exceeded" : "completed",
        completedAt: new Date(),
      },
    });
    emit({
      type: "run:completed",
      runId,
      projectId,
      detail: {
        mappings: mappingCount,
        gaps: gapCount,
        suggestions: suggestionCount,
        budgetExceeded,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.testCoverageRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: message,
        phaseProgress: JSON.stringify(progress),
      },
    });
    emit({ type: "run:failed", runId, projectId, error: message });
  }

  async function advance(
    phase: TestCoveragePhase,
    state: "running" | "done" | "skipped",
    detail?: Record<string, unknown>,
  ): Promise<void> {
    progress[phase] = state;
    await db.testCoverageRun.update({
      where: { id: runId },
      data: { phaseProgress: JSON.stringify(progress) },
    });
    emit({ type: "run:progress", runId, projectId, phase, detail });
  }
}

/**
 * Module-level runtime config (Epic #880, issue #886).
 *
 * `apiRouter()` is constructed in `createApp()` before the live Socket.IO
 * server exists, so the router cannot supply a `caller` / socket `emitter`
 * at build time. Following the established `configureXxxService` singleton
 * pattern, `server.ts` calls {@link configureTestCoverageRuntime} once `io`
 * and the AI provider are available. The default `enqueueRun` merges this
 * runtime config in at enqueue time, so judge/suggest phases actually run
 * in production instead of being silently skipped.
 */
let runtimeDeps: TestCoverageRunnerDeps = {};

/** Wire the production caller/emitter for the background runner. */
export function configureTestCoverageRuntime(deps: TestCoverageRunnerDeps): void {
  runtimeDeps = { ...deps };
}

/** Reset the runtime config — test helper. */
export function __resetTestCoverageRuntime(): void {
  runtimeDeps = {};
}

/** Merge runner deps, with explicitly-defined `override` values winning. */
function mergeRunnerDeps(
  base: TestCoverageRunnerDeps,
  override: TestCoverageRunnerDeps,
): TestCoverageRunnerDeps {
  const merged: TestCoverageRunnerDeps = { ...base };
  for (const [key, value] of Object.entries(override) as [
    keyof TestCoverageRunnerDeps,
    TestCoverageRunnerDeps[keyof TestCoverageRunnerDeps],
  ][]) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * Returns the default `enqueueRun` hook for the REST router. Schedules a
 * background run on the next tick so the HTTP response is never blocked.
 * Errors are persisted to `TestCoverageRun.status = "failed"` by the runner
 * itself, so the returned promise resolves quietly on failure.
 *
 * The module-level runtime config (set via {@link configureTestCoverageRuntime})
 * is resolved at enqueue time so the caller/emitter wired after router
 * construction still take effect.
 */
export function createDefaultEnqueueRun(
  deps: TestCoverageRunnerDeps = {},
): (input: RunTestCoverageJobInput) => Promise<void> {
  return async (input) => {
    setImmediate(() => {
      const resolved = mergeRunnerDeps(runtimeDeps, deps);
      runTestCoverageJob(input, resolved).catch(() => {
        /* runner finalises status; swallow here */
      });
    });
  };
}

/** Hydrate a TestCaseDoc row into the NormalisedTestCase shape the indexer expects. */
function hydrateCase(row: {
  title: string;
  preconditions: string | null;
  stepsJson: string;
  expected: string | null;
  priority: string;
  tags: string;
  externalId: string | null;
  source: string;
}): NormalisedTestCase {
  const partial: Parameters<typeof finaliseCase>[0] = {
    title: row.title,
    preconditions: row.preconditions ?? undefined,
    steps: safeJsonSteps(row.stepsJson),
    expected: row.expected ?? undefined,
    priority: row.priority as NormalisedTestCase["priority"],
    tags: safeJsonStrings(row.tags),
    externalId: row.externalId ?? undefined,
  };
  const finalised = finaliseCase(partial, row.source as TestCaseSource);
  // Persisted rows have already passed validation; the only failure mode is
  // an upstream schema drift, which we surface as a hard runtime error.
  if (!finalised) {
    throw new Error(`Persisted test case failed re-validation: ${row.title}`);
  }
  return finalised;
}

function safeJsonSteps(raw: string): { action: string; expected?: string }[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (s): s is { action: string; expected?: string } =>
        s && typeof s === "object" && typeof (s as { action?: unknown }).action === "string",
    );
  } catch {
    return [];
  }
}

function safeJsonStrings(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
