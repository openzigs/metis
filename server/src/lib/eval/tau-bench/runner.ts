/**
 * Epic #194 (C.2) — TAU-bench nightly runner.
 *
 * Same shape as the SWE-bench-Pro runner: gated on `EVAL_NIGHTLY_ENABLED`,
 * iterates the corpus, drives the orchestrator via a sandbox/agent
 * adapter, scores with {@link scoreScenario}, and persists `BenchRun` +
 * per-task `BenchTaskResult` rows.
 */
import { prisma } from "../../prisma.js";
import { loadScenarios, type ScenarioOptions, type TauScenario } from "./scenarios.js";
import { scoreScenario } from "./scorer.js";
import type { ExpectedToolCall } from "./scenarios.js";

export interface AgentLike {
  run(scenario: TauScenario): Promise<{
    actualToolCalls: ExpectedToolCall[];
    actualFinalState: Record<string, unknown>;
    tokens: number;
    costCents: number;
    latencyMs: number;
  }>;
}

export interface RunTauBenchInput {
  model: string;
  corpus?: ScenarioOptions;
  agent: AgentLike;
  isEnabled?: () => boolean;
  costCapCents?: number;
}

export interface RunTauBenchResult {
  benchRunId: string;
  status: "completed" | "disabled" | "failed";
  totalTasks: number;
  passedTasks: number;
  score: number;
  meanCostCents: number;
}

export const TAU_BENCH = "tau-bench" as const;

export function isTauBenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EVAL_NIGHTLY_ENABLED ?? "").toLowerCase() === "true";
}

export async function runTauBench(input: RunTauBenchInput): Promise<RunTauBenchResult> {
  const enabled = (input.isEnabled ?? isTauBenchEnabled)();
  const startedAt = new Date();
  if (!enabled) {
    const run = await prisma.benchRun.create({
      data: {
        benchmark: TAU_BENCH,
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

  const scenarios = await loadScenarios(input.corpus);
  const run = await prisma.benchRun.create({
    data: {
      benchmark: TAU_BENCH,
      model: input.model,
      startedAt,
      status: "running",
      totalTasks: scenarios.length,
    },
  });

  let passed = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let totalLatency = 0;
  const cap = input.costCapCents ?? Infinity;
  let stoppedAtCap = false;

  for (const scenario of scenarios) {
    if (totalCost >= cap) {
      stoppedAtCap = true;
      break;
    }
    let outcome: Awaited<ReturnType<AgentLike["run"]>>;
    let error: string | null = null;
    try {
      outcome = await input.agent.run(scenario);
    } catch (err) {
      error = (err as Error).message;
      outcome = {
        actualToolCalls: [],
        actualFinalState: {},
        tokens: 0,
        costCents: 0,
        latencyMs: 0,
      };
    }
    const result = scoreScenario({
      expectedToolCalls: scenario.expectedToolCalls,
      actualToolCalls: outcome.actualToolCalls,
      expectedFinalState: scenario.finalState,
      actualFinalState: outcome.actualFinalState,
    });
    if (result.passed) passed += 1;
    totalTokens += outcome.tokens;
    totalCost += outcome.costCents;
    totalLatency += outcome.latencyMs;
    await prisma.benchTaskResult.create({
      data: {
        benchRunId: run.id,
        taskId: scenario.scenarioId,
        passed: result.passed,
        score: result.score,
        tokens: outcome.tokens,
        costCents: outcome.costCents,
        latencyMs: outcome.latencyMs,
        expected: JSON.stringify({
          toolCalls: scenario.expectedToolCalls,
          finalState: scenario.finalState,
        }),
        actual: JSON.stringify({
          toolCalls: outcome.actualToolCalls,
          finalState: outcome.actualFinalState,
        }),
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
