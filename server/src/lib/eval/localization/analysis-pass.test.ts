import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_TIMEOUT_MS,
  createMaterializedAnalysisPass,
  waitForAnalysis,
  type AnalysisRunState,
  type MaterializedAnalysisPassDeps,
} from "./analysis-pass.js";
import type { MaterializedState } from "./materialize.js";

const STATE: MaterializedState = {
  version: 1,
  corpus: "toy-corpus",
  databaseUrl: "file:/x/eval.db",
  cloneRoot: "/x/clones",
  lancedbPath: "/x/lancedb",
  embedModel: "toy",
  materializedAt: "2026-11-05T00:00:00Z",
  repos: [
    {
      name: "r",
      url: "https://github.com/o/r",
      sha: "0".repeat(40),
      projectId: "proj-r",
      connectorId: "conn-r",
      cloneDir: "/x/clones/conn-r",
      symbols: 3,
    },
  ],
};

/** A run whose row and pipeline move through the given states, one per poll. */
function deps(
  states: Array<AnalysisRunState & { active: boolean }>,
  over: Partial<MaterializedAnalysisPassDeps> = {},
) {
  let i = 0;
  const current = () => states[Math.min(i, states.length - 1)]!;
  let clock = 0;
  const d: MaterializedAnalysisPassDeps = {
    states: new Map([["toy-corpus", STATE]]),
    start: vi.fn(async () => ({ id: "an-1" })),
    readState: vi.fn(async () => {
      const s = current();
      return { status: s.status, errorMessage: s.errorMessage };
    }),
    isActive: vi.fn(() => current().active),
    cancel: vi.fn(async () => true),
    requirementIds: vi.fn(async () => ["req-1", "req-2"]),
    sleep: vi.fn(async () => {
      i++;
      clock += 1000;
    }),
    now: () => clock,
    ...over,
  };
  return d;
}

const running = { status: "running", errorMessage: null, active: true };
const done = { status: "completed", errorMessage: null, active: false };

describe("createMaterializedAnalysisPass (#1818)", () => {
  it("starts the analysis on the repository's project and returns the requirements it persisted", async () => {
    const d = deps([running, running, done]);
    const out = await createMaterializedAnalysisPass(d)({
      corpus: "toy-corpus",
      repo: "r",
      text: "Do it.",
    });
    expect(d.start).toHaveBeenCalledWith({ projectId: "proj-r", text: "Do it." });
    expect(out).toEqual({
      analysisId: "an-1",
      status: "completed",
      requirementIds: ["req-1", "req-2"],
    });
  });

  it("refuses a corpus or repository that is not materialized, before starting anything", async () => {
    const d = deps([done]);
    const pass = createMaterializedAnalysisPass(d);
    await expect(pass({ corpus: "other", repo: "r", text: "x" })).rejects.toThrow(
      /other is not materialized/,
    );
    await expect(pass({ corpus: "toy-corpus", repo: "q", text: "x" })).rejects.toThrow(
      /repository q is not materialized/,
    );
    expect(d.start).not.toHaveBeenCalled();
  });

  it("throws when the run ends failed, with its error, and reads no requirement", async () => {
    const d = deps([{ status: "failed", errorMessage: "provider down", active: false }]);
    await expect(
      createMaterializedAnalysisPass(d)({ corpus: "toy-corpus", repo: "r", text: "x" }),
    ).rejects.toThrow(/an-1 \(toy-corpus\/r\) ended failed: provider down/);
    expect(d.requirementIds).not.toHaveBeenCalled();
  });
});

describe("waitForAnalysis (#1818)", () => {
  it("waits for the pipeline to return, not only for the row to read completed", async () => {
    // The row reads completed while the pipeline still writes the citations.
    const d = deps([{ ...done, active: true }, { ...done, active: true }, done]);
    await expect(waitForAnalysis("an-1", d)).resolves.toEqual({
      status: "completed",
      errorMessage: null,
    });
    expect(d.sleep).toHaveBeenCalledTimes(2);
  });

  it("cancels and throws a run that outlives the timeout", async () => {
    const d = deps([running], { timeoutMs: 3000 });
    await expect(waitForAnalysis("an-1", d)).rejects.toThrow(/did not finish within 3 s/);
    expect(d.cancel).toHaveBeenCalledWith("an-1");
    expect(ANALYSIS_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("throws when the row is not in the eval database", async () => {
    const d = deps([done], { readState: async () => null });
    await expect(waitForAnalysis("an-1", d)).rejects.toThrow(/not in the eval database/);
  });
});
