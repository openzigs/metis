/**
 * Epic #194 (C.1) — SWE-bench-Pro nightly runner.
 *
 * Drives the full bench loop:
 *   1. Load tasks via {@link loadCorpus}.
 *   2. For each task, run the METIS orchestrator inside the sandbox
 *      (Epic A.1 `code_exec`) to produce a candidate patch.
 *   3. Score the patch with {@link scoreTask}.
 *   4. Persist a `BenchRun` + per-task `BenchTaskResult` rows.
 *
 * The runner is gated behind `EVAL_NIGHTLY_ENABLED=true`. When unset the
 * cron job calls {@link runSweBench} which short-circuits to a no-op
 * `disabled` BenchRun so the leaderboard can surface "Disabled" rather
 * than silently dropping nightly runs.
 *
 * FinOps: each task costs are summed and rolled up into the BenchRun for
 * the per-benchmark cost cap (Epic #164 budget enforcer).
 */
import { prisma } from "../../prisma.js";
import { loadCorpus, type CorpusOptions, type SweBenchTask } from "./corpus.js";
import { scoreTask, type SandboxOutcome } from "./scorer.js";

export interface SandboxLike {
  /**
   * Run a SWE-bench-Pro task end-to-end. Implementations talk to the
   * sandbox sidecar (production) or return a deterministic stub (tests).
   */
  apply(task: SweBenchTask): Promise<{
    actualPatch: string;
    sandbox: SandboxOutcome;
    tokens: number;
    costCents: number;
    latencyMs: number;
  }>;
}

export interface RunSweBenchInput {
  model: string;
  /** Test seam — supply tasks directly. */
  corpus?: CorpusOptions;
  /** Test seam — drive the sandbox interactions. */
  sandbox: SandboxLike;
  /** Override the env-flag check (defaults to `EVAL_NIGHTLY_ENABLED`). */
  isEnabled?: () => boolean;
  /** Per-benchmark FinOps ceiling in cents — runner stops once exceeded. */
  costCapCents?: number;
}

export interface RunSweBenchResult {
  benchRunId: string;
  status: "completed" | "disabled" | "failed";
  totalTasks: number;
  passedTasks: number;
  score: number;
  meanCostCents: number;
}

export const SWE_BENCH = "swe-bench-pro" as const;

export function isSweBenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EVAL_NIGHTLY_ENABLED ?? "").toLowerCase() === "true";
}

export async function runSweBench(input: RunSweBenchInput): Promise<RunSweBenchResult> {
  const enabled = (input.isEnabled ?? isSweBenchEnabled)();
  const startedAt = new Date();
  if (!enabled) {
    const run = await prisma.benchRun.create({
      data: {
        benchmark: SWE_BENCH,
        model: input.model,
        startedAt,
        completedAt: startedAt,
        status: "disabled",
        metadata: JSON.stringify({ reason: "EVAL_NIGHTLY_ENABLED is not 'true'" }),
      },
    });
    return {
      benchRunId: run.id,
      status: "disabled",
      totalTasks: 0,
      passedTasks: 0,
      score: 0,
      meanCostCents: 0,
    };
  }

  const tasks = await loadCorpus(input.corpus);
  const run = await prisma.benchRun.create({
    data: {
      benchmark: SWE_BENCH,
      model: input.model,
      startedAt,
      status: "running",
      totalTasks: tasks.length,
    },
  });

  let passed = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let totalLatency = 0;
  const cap = input.costCapCents ?? Infinity;
  let stoppedAtCap = false;

  for (const task of tasks) {
    if (totalCost >= cap) {
      stoppedAtCap = true;
      break;
    }
    let outcome: Awaited<ReturnType<SandboxLike["apply"]>>;
    let error: string | null = null;
    try {
      outcome = await input.sandbox.apply(task);
    } catch (err) {
      error = (err as Error).message;
      outcome = {
        actualPatch: "",
        sandbox: { exitCode: 1, stdout: "", stderr: error },
        tokens: 0,
        costCents: 0,
        latencyMs: 0,
      };
    }
    const result = scoreTask({
      expectedPatch: task.expectedPatch,
      actualPatch: outcome.actualPatch,
      sandbox: outcome.sandbox,
    });
    if (result.passed) passed += 1;
    totalTokens += outcome.tokens;
    totalCost += outcome.costCents;
    totalLatency += outcome.latencyMs;
    await prisma.benchTaskResult.create({
      data: {
        benchRunId: run.id,
        taskId: task.taskId,
        passed: result.passed,
        score: result.score,
        tokens: outcome.tokens,
        costCents: outcome.costCents,
        latencyMs: outcome.latencyMs,
        expected: task.expectedPatch,
        actual: outcome.actualPatch,
        error,
      },
    });
  }

  const ranTasks = await prisma.benchTaskResult.count({ where: { benchRunId: run.id } });
  const score = ranTasks > 0 ? passed / ranTasks : 0;
  const meanCostCents = ranTasks > 0 ? Math.round(totalCost / ranTasks) : 0;
  await prisma.benchRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      passedTasks: passed,
      score,
      meanTokens: ranTasks > 0 ? Math.round(totalTokens / ranTasks) : 0,
      meanCostCents,
      meanLatencyMs: ranTasks > 0 ? Math.round(totalLatency / ranTasks) : 0,
      completedAt: new Date(),
      metadata: JSON.stringify({ stoppedAtCap, costCapCents: input.costCapCents ?? null }),
    },
  });

  return {
    benchRunId: run.id,
    status: "completed",
    totalTasks: ranTasks,
    passedTasks: passed,
    score,
    meanCostCents,
  };
}
