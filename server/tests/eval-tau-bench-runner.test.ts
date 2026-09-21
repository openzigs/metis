/**
 * Epic #194 (C.2) — TAU-bench runner tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { benchRunCreate, benchRunUpdate, taskCreate, taskCount } = vi.hoisted(() => ({
  benchRunCreate: vi.fn(),
  benchRunUpdate: vi.fn(async () => ({})),
  taskCreate: vi.fn(async () => ({})),
  taskCount: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    benchRun: { create: benchRunCreate, update: benchRunUpdate },
    benchTaskResult: { create: taskCreate, count: taskCount },
  },
}));

import {
  isTauBenchEnabled,
  runTauBench,
  TAU_BENCH,
  type AgentLike,
} from "../src/lib/eval/tau-bench/runner.js";
import type { TauScenario } from "../src/lib/eval/tau-bench/scenarios.js";

const mkScenario = (n: number): TauScenario => ({
  scenarioId: `s-${n}`,
  prompt: "Help me",
  tools: ["lookup", "update"],
  expectedToolCalls: [
    { name: "lookup", args: { id: n } },
    { name: "update", args: { id: n, status: "done" } },
  ],
  finalState: { status: "done" },
});

beforeEach(() => {
  benchRunCreate.mockReset();
  benchRunUpdate.mockReset();
  benchRunUpdate.mockResolvedValue({});
  taskCreate.mockReset();
  taskCreate.mockResolvedValue({});
  taskCount.mockReset();
  delete process.env.EVAL_NIGHTLY_ENABLED;
});

describe("isTauBenchEnabled", () => {
  it("requires EVAL_NIGHTLY_ENABLED=true", () => {
    expect(isTauBenchEnabled({ EVAL_NIGHTLY_ENABLED: "true" })).toBe(true);
    expect(isTauBenchEnabled({})).toBe(false);
  });
});

describe("runTauBench", () => {
  it("writes a disabled BenchRun when the flag is unset", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-d" });
    const agent: AgentLike = { run: vi.fn() };
    const result = await runTauBench({ model: "gpt-5", agent, isEnabled: () => false });
    expect(result.status).toBe("disabled");
    expect(agent.run).not.toHaveBeenCalled();
    expect(benchRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ benchmark: TAU_BENCH, status: "disabled" }),
      }),
    );
  });

  it("scores scenarios and rolls up the run", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-1" });
    taskCount.mockResolvedValueOnce(2);
    const scenarios = [mkScenario(1), mkScenario(2)];
    const agent: AgentLike = {
      run: vi
        .fn()
        // perfect run
        .mockResolvedValueOnce({
          actualToolCalls: scenarios[0]!.expectedToolCalls,
          actualFinalState: scenarios[0]!.finalState,
          tokens: 10,
          costCents: 1,
          latencyMs: 5,
        })
        // wrong tool call → partial
        .mockResolvedValueOnce({
          actualToolCalls: [{ name: "wrong", args: {} }],
          actualFinalState: { status: "wrong" },
          tokens: 20,
          costCents: 2,
          latencyMs: 10,
        }),
    };
    const result = await runTauBench({
      model: "gpt-5",
      agent,
      isEnabled: () => true,
      corpus: { inMemory: scenarios },
    });
    expect(result.status).toBe("completed");
    expect(result.passedTasks).toBe(1);
    expect(result.totalTasks).toBe(2);
    expect(result.score).toBeCloseTo(0.5);
  });

  it("captures agent errors as failures", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-2" });
    taskCount.mockResolvedValueOnce(1);
    const agent: AgentLike = {
      run: vi.fn().mockRejectedValueOnce(new Error("agent crashed")),
    };
    const result = await runTauBench({
      model: "gpt-5",
      agent,
      isEnabled: () => true,
      corpus: { inMemory: [mkScenario(1)] },
    });
    expect(result.passedTasks).toBe(0);
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: "agent crashed", passed: false }),
      }),
    );
  });

  it("respects the FinOps cap", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-3" });
    taskCount.mockResolvedValueOnce(1);
    const scenarios = [mkScenario(1), mkScenario(2)];
    const agent: AgentLike = {
      run: vi.fn().mockResolvedValue({
        actualToolCalls: scenarios[0]!.expectedToolCalls,
        actualFinalState: scenarios[0]!.finalState,
        tokens: 1,
        costCents: 100,
        latencyMs: 1,
      }),
    };
    await runTauBench({
      model: "gpt-5",
      agent,
      isEnabled: () => true,
      corpus: { inMemory: scenarios },
      costCapCents: 50,
    });
    expect(agent.run).toHaveBeenCalledTimes(1);
  });
});
