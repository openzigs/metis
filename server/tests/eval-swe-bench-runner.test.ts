/**
 * Epic #194 (C.1) — SWE-bench-Pro runner tests.
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
    benchRun: {
      create: benchRunCreate,
      update: benchRunUpdate,
    },
    benchTaskResult: {
      create: taskCreate,
      count: taskCount,
    },
  },
}));

import {
  isSweBenchEnabled,
  runSweBench,
  SWE_BENCH,
  type SandboxLike,
} from "../src/lib/eval/swe-bench/runner.js";
import type { SweBenchTask } from "../src/lib/eval/swe-bench/corpus.js";

const mkTask = (n: number): SweBenchTask => ({
  taskId: `task-${n}`,
  repo: "org/repo",
  baseCommit: "deadbeef",
  prompt: "Fix it",
  expectedPatch: `diff --git a/x.py b/x.py\n@@\n+task ${n} fix line one\n+task ${n} fix line two`,
  testCommand: "pytest",
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

describe("isSweBenchEnabled", () => {
  it("requires EVAL_NIGHTLY_ENABLED=true", () => {
    delete process.env.EVAL_NIGHTLY_ENABLED;
    expect(isSweBenchEnabled()).toBe(false);
    process.env.EVAL_NIGHTLY_ENABLED = "false";
    expect(isSweBenchEnabled()).toBe(false);
    process.env.EVAL_NIGHTLY_ENABLED = "TRUE";
    expect(isSweBenchEnabled()).toBe(true);
  });
});

describe("runSweBench", () => {
  it("writes a disabled BenchRun when the flag is unset", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-disabled" });
    const sandbox: SandboxLike = { apply: vi.fn() };
    const result = await runSweBench({
      model: "gpt-5",
      sandbox,
      isEnabled: () => false,
    });
    expect(result.status).toBe("disabled");
    expect(result.benchRunId).toBe("r-disabled");
    expect(sandbox.apply).not.toHaveBeenCalled();
    expect(benchRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ benchmark: SWE_BENCH, status: "disabled" }),
      }),
    );
  });

  it("scores tasks, persists per-task rows, and rolls up the run", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-1" });
    taskCount.mockResolvedValueOnce(2);
    const tasks = [mkTask(1), mkTask(2)];
    const sandbox: SandboxLike = {
      apply: vi
        .fn()
        // task 1 — passes
        .mockResolvedValueOnce({
          actualPatch: tasks[0]!.expectedPatch,
          sandbox: { exitCode: 0, stdout: "ok", stderr: "" },
          tokens: 100,
          costCents: 5,
          latencyMs: 200,
        })
        // task 2 — fails (sandbox red)
        .mockResolvedValueOnce({
          actualPatch: tasks[1]!.expectedPatch,
          sandbox: { exitCode: 1, stdout: "", stderr: "fail" },
          tokens: 50,
          costCents: 2,
          latencyMs: 100,
        }),
    };
    const result = await runSweBench({
      model: "gpt-5",
      sandbox,
      isEnabled: () => true,
      corpus: { inMemory: tasks },
    });
    expect(result.status).toBe("completed");
    expect(result.totalTasks).toBe(2);
    expect(result.passedTasks).toBe(1);
    expect(result.score).toBeCloseTo(0.5);
    expect(taskCreate).toHaveBeenCalledTimes(2);
    expect(benchRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r-1" },
        data: expect.objectContaining({ status: "completed", passedTasks: 1 }),
      }),
    );
  });

  it("captures sandbox errors as task failures rather than crashing the run", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-2" });
    taskCount.mockResolvedValueOnce(1);
    const sandbox: SandboxLike = {
      apply: vi.fn().mockRejectedValueOnce(new Error("sandbox blew up")),
    };
    const result = await runSweBench({
      model: "gpt-5",
      sandbox,
      isEnabled: () => true,
      corpus: { inMemory: [mkTask(1)] },
    });
    expect(result.status).toBe("completed");
    expect(result.passedTasks).toBe(0);
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: "sandbox blew up", passed: false }),
      }),
    );
  });

  it("stops once the FinOps cap is exceeded", async () => {
    benchRunCreate.mockResolvedValueOnce({ id: "r-3" });
    taskCount.mockResolvedValueOnce(1);
    const tasks = [mkTask(1), mkTask(2), mkTask(3)];
    const sandbox: SandboxLike = {
      apply: vi.fn().mockResolvedValue({
        actualPatch: tasks[0]!.expectedPatch,
        sandbox: { exitCode: 0, stdout: "ok", stderr: "" },
        tokens: 1,
        costCents: 100,
        latencyMs: 1,
      }),
    };
    const result = await runSweBench({
      model: "gpt-5",
      sandbox,
      isEnabled: () => true,
      corpus: { inMemory: tasks },
      costCapCents: 50,
    });
    expect(sandbox.apply).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
  });
});
