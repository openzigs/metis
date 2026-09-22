/**
 * Tests for the coverage scoring orchestrator (Epic #856 issue #858).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  runCoverageScoring,
  type CoverageProgressEvent,
  type CoverageServiceDeps,
} from "../../../src/lib/testcoverage/coverage-service.js";
import type { JudgeModelCaller } from "../../../src/lib/testcoverage/judge.js";
import { __resetSemanticCacheSingleton } from "../../../src/lib/ai/semantic-cache.js";
import { __resetTokenTrackerSingleton } from "../../../src/lib/ai/token-tracker.js";
import { prisma } from "../../../src/lib/prisma.js";

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
    // The in-process transformers.js backend: no per-token charge (#58).
    key: "xenova",
    // What the embedder is configured with; `embed()` reports the model that ran.
    model: "configured-model",
    dimension: 4,
    async embed(texts: string[]) {
      return {
        model: "test-model",
        dimension: 4,
        vectors: texts.map((t) => {
          const v = [0, 0, 0, 0];
          for (let i = 0; i < t.length; i += 1) v[i % 4] += t.charCodeAt(i) / 1000;
          let n = 0;
          for (const x of v) n += x * x;
          n = Math.sqrt(n) || 1;
          return v.map((x) => x / n);
        }),
      };
    },
    async warm() {},
  }),
}));

vi.mock("../../../src/lib/judge/hallucination-scorer.js", () => ({
  scoreGrounding: vi.fn(async () => ({ groundingScore: 0.9, hallucinationScore: 0.1 })),
}));

// #876 — the token tracker fire-and-forgets `prisma.aITokenUsage.create()` through the REAL
// Prisma singleton (`queueMicrotask(() => void this.persist(...))`) and logs on failure. The
// `makeDb()` double below is injected into the service and never covers that write, so it
// escaped to a real datasource and outlived the test file: against Postgres the failure
// arrives only after a socket round-trip, so the log landed during worker teardown as
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` — every test
// passing, exit code 1.
vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  },
}));

beforeEach(() => {
  __resetSemanticCacheSingleton();
  __resetTokenTrackerSingleton();
  vi.mocked(prisma.aITokenUsage.create).mockClear();
});

interface MockDbState {
  mappings: unknown[];
  gaps: unknown[];
  suggestions: unknown[];
  run: Record<string, unknown>;
}

function makeDb(opts: {
  requirements: { id: string; title: string; body: string; priority: string }[];
  testCases?: {
    id: string;
    title: string;
    stepsJson: string;
    priority: string;
    tags: string;
    source: string;
    preconditions: string | null;
    expected: string | null;
    externalId: string | null;
    contentHash: string;
  }[];
}) {
  const state: MockDbState = {
    mappings: [],
    gaps: [],
    suggestions: [],
    run: { tokenCostCents: 0, embeddingTokens: 0, judgeTokens: 0, suggestionTokens: 0 },
  };
  return {
    state,
    db: {
      requirement: {
        findMany: vi.fn(async () => opts.requirements),
      },
      testCaseDoc: {
        findMany: vi.fn(async () => opts.testCases ?? []),
      },
      coverageMapping: {
        deleteMany: vi.fn(async () => ({ count: state.mappings.length })),
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
          state.mappings.push(...data);
          return { count: data.length };
        }),
      },
      gapItem: {
        deleteMany: vi.fn(async () => ({ count: state.gaps.length })),
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
          state.gaps.push(...data);
          return { count: data.length };
        }),
      },
      suggestion: {
        deleteMany: vi.fn(async () => ({ count: state.suggestions.length })),
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
          state.suggestions.push(...data);
          return { count: data.length };
        }),
      },
      aISession: {
        upsert: vi.fn(async ({ create }: { create: { id: string } }) => create),
      },
      testCoverageRun: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state.run, data);
          return state.run;
        }),
        findUnique: vi.fn(async () => ({ ...state.run })),
      },
    },
  };
}

const stubCaller: JudgeModelCaller = {
  async call() {
    return {
      raw: JSON.stringify({
        suggestions: [
          {
            title: "Cover login lockout",
            priority: "high",
            preconditions: ["user exists"],
            steps: [{ action: "submit bad pwd 5x", expected: "locked" }],
            bdd: {
              feature: "Auth",
              scenario: "Lockout",
              given: ["user exists"],
              when: ["wrong 5x"],
              then: ["locked"],
            },
            tags: ["auth"],
            mappedRequirementIds: ["r1"],
            sourceChunks: [],
            confidence: 0.85,
          },
        ],
      }),
      promptTokens: 100,
      completionTokens: 50,
      provider: "bedrock-gateway" as const,
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    };
  },
};

describe("runCoverageScoring", () => {
  it("returns an empty report when there are no requirements", async () => {
    const { db } = makeDb({ requirements: [] });
    const report = await runCoverageScoring({ runId: "run-1", projectId: "p-1", userId: "u-1" }, {
      db: db as never,
      caller: stubCaller,
    } satisfies CoverageServiceDeps);
    expect(report.matcher.requirements).toBe(0);
    expect(report.coveragePct).toBe(0);
  });

  it("runs through all phases and persists rows", async () => {
    const { db, state } = makeDb({
      requirements: [
        {
          id: "r1",
          title: "Login lockout",
          body: "Lock after 5 failed attempts.",
          priority: "high",
        },
      ],
      testCases: [],
    });
    const events: CoverageProgressEvent[] = [];
    const report = await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      {
        db: db as never,
        caller: stubCaller,
        emit: (e) => events.push(e),
      },
    );
    expect(events.map((e) => e.phase)).toEqual(
      expect.arrayContaining(["match", "judge", "suggest"]),
    );
    expect(report.matcher.requirements).toBe(1);
    // With no test cases the requirement is uncovered → gap row inserted.
    expect(state.gaps.length).toBeGreaterThan(0);
    // Suggestion generation runs and persists rows.
    expect(report.suggestions.generated).toBeGreaterThanOrEqual(0);
  });

  it("emits running and done events for each phase", async () => {
    const { db } = makeDb({
      requirements: [{ id: "r1", title: "X", body: "body", priority: "low" }],
    });
    const events: CoverageProgressEvent[] = [];
    await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: stubCaller, emit: (e) => events.push(e) },
    );
    const matchStates = events.filter((e) => e.phase === "match").map((e) => e.state);
    expect(matchStates).toEqual(["running", "done"]);
  });

  it("hydrates existing test cases and persists coverage mappings", async () => {
    const { db, state } = makeDb({
      requirements: [
        { id: "r1", title: "Login lockout", body: "Lock after 5 fails.", priority: "high" },
      ],
      testCases: [
        {
          id: "tc1",
          title: "Login lockout test",
          preconditions: "user exists",
          stepsJson: JSON.stringify([{ action: "enter bad password", expected: "rejected" }]),
          expected: "account locked",
          priority: "high",
          tags: JSON.stringify(["auth"]),
          source: "csv",
          externalId: null,
          contentHash: "h1",
        },
      ],
    });
    const report = await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: stubCaller },
    );
    expect(report.matcher.requirements).toBe(1);
    expect(state.mappings.length).toBeGreaterThan(0);
  });

  it("tolerates malformed steps/tags JSON on existing cases", async () => {
    const { db } = makeDb({
      requirements: [{ id: "r1", title: "X", body: "body content", priority: "low" }],
      testCases: [
        {
          id: "tc1",
          title: "Malformed case",
          preconditions: null,
          stepsJson: "not-json",
          expected: null,
          priority: "medium",
          tags: "also-not-json",
          source: "csv",
          externalId: null,
          contentHash: "h1",
        },
      ],
    });
    const report = await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: stubCaller },
    );
    expect(report.matcher.requirements).toBe(1);
  });

  it("reports cost breakdown from the tracker", async () => {
    const { db } = makeDb({
      requirements: [{ id: "r1", title: "X", body: "body", priority: "medium" }],
    });
    const report = await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: stubCaller, budgetCents: 500 },
    );
    expect(report.cost.limitCents).toBe(500);
    expect(report.cost.usedCents).toBeGreaterThanOrEqual(0);
    expect(report.cost.remainingCents).toBeGreaterThanOrEqual(0);
  });

  it("does not flag budgetExceeded for a run comfortably under budget (#883)", async () => {
    const { db } = makeDb({
      requirements: [{ id: "r1", title: "X", body: "body", priority: "low" }],
    });
    const report = await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: stubCaller, budgetCents: 10_000 },
    );
    expect(report.budgetExceeded).toBe(false);
  });

  it("hard-stops the suggestion phase when the budget is exhausted (#883)", async () => {
    const { db, state } = makeDb({
      // Uncovered requirement (no test cases) would normally trigger suggestions.
      requirements: [{ id: "r1", title: "X", body: "body", priority: "high" }],
      testCases: [],
    });
    const callerSpy: JudgeModelCaller = { call: vi.fn(stubCaller.call) };
    const events: CoverageProgressEvent[] = [];
    const report = await runCoverageScoring(
      { runId: "run-1", projectId: "p-1", userId: "u-1" },
      // budgetCents: 0 → exceeded() is true from the outset, forcing the hard-stop.
      { db: db as never, caller: callerSpy, budgetCents: 0, emit: (e) => events.push(e) },
    );
    // No LLM calls were made once the budget was exhausted.
    expect(callerSpy.call).not.toHaveBeenCalled();
    // No suggestions were generated.
    expect(report.suggestions.generated).toBe(0);
    expect(state.suggestions.length).toBe(0);
    // The condition is surfaced, not silent.
    expect(report.budgetExceeded).toBe(true);
    const suggestDone = events.find((e) => e.phase === "suggest" && e.state === "done");
    expect(suggestDone?.detail).toMatchObject({ budgetExceeded: true });
  });

  it("records suggestion usage under what served it, and reports unpriced spend as such (#43)", async () => {
    // AI_PROVIDER=anthropic with ANTHROPIC_BASE_URL at DeepSeek: the call is
    // served, and billed, by a model METIS has no price for.
    const { db, state } = makeDb({
      requirements: [{ id: "r1", title: "Login lockout", body: "lock after 5", priority: "high" }],
    });
    const unpricedCaller: JudgeModelCaller = {
      call: vi.fn(async (input) => ({
        ...(await stubCaller.call(input)),
        provider: "anthropic" as const,
        model: "deepseek-v4-pro",
      })),
    };
    const report = await runCoverageScoring(
      { runId: "run-unpriced", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: unpricedCaller, budgetCents: 10_000 },
    );
    expect(unpricedCaller.call).toHaveBeenCalled();
    // Not $0 of spend: 150 tokens of unknown cost, kept apart from usedCents
    // (which holds only the priced embedding estimate).
    expect(report.cost.unpricedTokens).toBe(150);
    expect(state.run.suggestionTokens).toBe(150);
    // The run's AI session exists, so its usage rows can reference it.
    expect(db.aISession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "testCoverageRun:run-unpriced" } }),
    );
  });
  /** Seventeen uncovered requirements → ⌈17/8⌉ = 3 suggestion clusters. */
  const manyRequirements = Array.from({ length: 17 }, (_, i) => ({
    id: `r${i}`,
    title: `Requirement ${i} ${"abcdefghijklmnopq"[i]}`,
    body: `${"xyz".repeat(i + 1)} behaviour ${i}`,
    priority: "medium",
  }));

  it("a priced run makes one suggestion call per cluster (control for #57)", async () => {
    const { db } = makeDb({ requirements: manyRequirements });
    const callerSpy: JudgeModelCaller = { call: vi.fn(stubCaller.call) };
    await runCoverageScoring(
      { runId: "run-control", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: callerSpy, budgetCents: 10_000 },
    );
    expect(vi.mocked(callerSpy.call).mock.calls.length).toBeGreaterThan(1);
  });

  it("an all-unpriced run whose judge had nothing to judge stops suggesting after the first unpriced call (#57)", async () => {
    // No test cases → no AMBIGUOUS pairs → the judge makes no call, so nothing
    // has shown the model is unpriced before the suggestion phase starts.
    const { db, state } = makeDb({ requirements: manyRequirements });
    const unpricedCaller: JudgeModelCaller = {
      call: vi.fn(async (input) => ({
        ...(await stubCaller.call(input)),
        provider: "openai" as const,
        model: "no-such-priced-model",
      })),
    };
    const events: CoverageProgressEvent[] = [];
    const report = await runCoverageScoring(
      { runId: "run-unpriced-57", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: unpricedCaller, budgetCents: 10_000, emit: (e) => events.push(e) },
    );
    expect(report.judge.modelCalls).toBe(0);
    expect(unpricedCaller.call).toHaveBeenCalledTimes(1);
    expect(report.budgetExceeded).toBe(true);
    const suggestDone = events.find((e) => e.phase === "suggest" && e.state === "done");
    expect(suggestDone?.detail).toMatchObject({ budgetExceeded: true });
    // The one call is on the budget exactly once.
    expect(report.cost.unpricedTokens).toBe(150);
    expect(state.run.suggestionTokens).toBe(150);
  });

  it("a priced run stops suggesting part-way once the budget is reached (#57)", async () => {
    const { db, state } = makeDb({ requirements: manyRequirements });
    const callerSpy: JudgeModelCaller = { call: vi.fn(stubCaller.call) };
    const report = await runCoverageScoring(
      { runId: "run-priced-57", projectId: "p-1", userId: "u-1" },
      // One suggestion call (150 Bedrock Haiku tokens) rounds up to 1 cent.
      { db: db as never, caller: callerSpy, budgetCents: 1 },
    );
    expect(callerSpy.call).toHaveBeenCalledTimes(1);
    expect(report.budgetExceeded).toBe(true);
    expect(report.cost.usedCents).toBe(1);
    expect(state.run.suggestionTokens).toBe(150);
  });

  it("a local-embedder run's embedding phase adds nothing to the run budget (#58)", async () => {
    // ~12.5k embedding tokens: at the Bedrock Haiku 4.5 price this was 2 cents.
    const { db, state } = makeDb({
      requirements: Array.from({ length: 20 }, (_, i) => ({
        id: `r${i}`,
        title: `Req ${i}`,
        body: `${i} `.repeat(1_000),
        priority: "low",
      })),
    });
    const silentCaller: JudgeModelCaller = {
      call: vi.fn(async () => ({
        raw: JSON.stringify({ suggestions: [] }),
        promptTokens: 0,
        completionTokens: 0,
        provider: "bedrock-gateway" as const,
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      })),
    };
    const report = await runCoverageScoring(
      { runId: "run-embed-58", projectId: "p-1", userId: "u-1" },
      { db: db as never, caller: silentCaller, budgetCents: 20 },
    );
    expect(state.run.embeddingTokens).toBeGreaterThan(10_000);
    expect(report.cost.usedCents).toBe(0);
    expect(state.run.tokenCostCents).toBe(0);
    expect(report.cost.unpricedTokens).toBe(0);
    expect(report.budgetExceeded).toBe(false);
    // The persisted usage row names the embedder that ran and prices it at $0.
    const rows = vi.mocked(prisma.aITokenUsage.create).mock.calls.map((c) => c[0].data);
    const embedding = rows.filter((r) => r.agentStep === "testcoverage.embedding");
    expect(embedding).toHaveLength(1);
    expect(embedding[0]).toMatchObject({
      provider: "embed:xenova",
      model: "test-model",
      estimatedCostUsd: 0,
    });
  });
});
