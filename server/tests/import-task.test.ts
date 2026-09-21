/**
 * import.run task handler — payload parsing and delegation to runSource.
 */
import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_RUN_TASK_TYPE,
  registerImportTaskHandlers,
} from "../src/lib/importers/import-task.js";
import type { ImportRunView } from "@metis/shared";

function fakeRun(over: Partial<ImportRunView> = {}): ImportRunView {
  return {
    id: "run_1",
    importSourceId: "src_1",
    projectId: "p1",
    trigger: "manual",
    status: "completed",
    taskId: "task_1",
    createdCount: 3,
    updatedCount: 1,
    skippedCount: 0,
    totalFetched: 4,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function ctx(payload: Record<string, unknown>, trigger = "manual") {
  return {
    task: { payload, trigger },
    signal: new AbortController().signal,
    reportProgress: vi.fn(),
    log: vi.fn(),
  };
}

describe("registerImportTaskHandlers", () => {
  it("registers the import.run task type", () => {
    const register = vi.fn();
    registerImportTaskHandlers({ register } as never, { runSource: vi.fn() as never });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: IMPORT_RUN_TASK_TYPE }));
  });

  it("delegates to runSource with the parsed payload and reuses the run id", async () => {
    let handler!: (c: unknown) => Promise<unknown>;
    const register = vi.fn((def: { handler: (c: unknown) => Promise<unknown> }) => {
      handler = def.handler;
    });
    const runSource = vi.fn(async () => fakeRun());
    registerImportTaskHandlers({ register } as never, { runSource: runSource as never });

    const out = await handler(ctx({ importSourceId: "src_1", importRunId: "run_1" }, "scheduled"));
    expect(runSource).toHaveBeenCalledWith(
      "src_1",
      expect.objectContaining({ trigger: "scheduled", runId: "run_1" }),
    );
    expect(out).toEqual({
      runId: "run_1",
      status: "completed",
      created: 3,
      updated: 1,
      skipped: 0,
    });
  });

  it("throws when importSourceId is missing", async () => {
    let handler!: (c: unknown) => Promise<unknown>;
    const register = vi.fn((def: { handler: (c: unknown) => Promise<unknown> }) => {
      handler = def.handler;
    });
    registerImportTaskHandlers({ register } as never, { runSource: vi.fn() as never });
    await expect(handler(ctx({}))).rejects.toThrow(/importSourceId/);
  });

  it("threads the progress reporter through to the task context", async () => {
    let handler!: (c: unknown) => Promise<unknown>;
    const register = vi.fn((def: { handler: (c: unknown) => Promise<unknown> }) => {
      handler = def.handler;
    });
    const runSource = vi.fn(
      async (_id: string, opts: { reportProgress?: (p: unknown) => void }) => {
        opts.reportProgress?.({ step: "fetch", current: 7, total: 10 });
        return fakeRun();
      },
    );
    registerImportTaskHandlers({ register } as never, { runSource: runSource as never });
    const c = ctx({ importSourceId: "src_1" });
    await handler(c);
    expect(c.reportProgress).toHaveBeenCalledWith({ step: "fetch", current: 7, total: 10 });
  });
});
