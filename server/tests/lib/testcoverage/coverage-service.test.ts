/**
 * Tests for the coverage scoring orchestrator (Epic #856 issue #858).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  runCoverageScoring,
  type CoverageProgressEvent,
  type CoverageServiceDeps,
} from "../../../src/lib/testcoverage/coverage-service.js";
import type { JudgeModelCaller } from "../../../src/lib/testcoverage/judge.js";
import { __resetSemanticCacheSingleton } from "../../../src/lib/ai/semantic-cache.js";
import { __resetTokenTrackerSingleton } from "../../../src/lib/ai/token-tracker.js";
import { prisma } from "../../../src/lib/prisma.js";

/**
 * Mutable embedder state, so a test can pick the backend that "ran" and pin
 * exact vectors. `key`/`model` are read back by the #58 embedding record;
 * `pins` maps a text PREFIX to a unit vector, which is how a test puts a
 * (req, case) pair in the matcher's AMBIGUOUS band deliberately — a prefix
 * because a test case's text is assembled by `caseText`, not supplied whole.
 * `calls` is every batch of texts the embedder was handed, in order.
 */
const embedState = vi.hoisted(() => ({
  key: "xenova",
  model: "test-model",
  pins: [] as [prefix: string, vector: number[]][],
  calls: [] as string[][],
}));

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
    // The in-process transformers.js backend: no per-token charge (#58).
    get key() {
      return embedState.key;
    },
    // What the embedder is configured with; `embed()` reports the model that ran.
    model: "configured-model",
    dimension: 4,
    async embed(texts: string[]) {
      embedState.calls.push([...texts]);
      return {
        model: embedState.model,
        dimension: 4,
        vectors: texts.map((t) => {
          const pinned = embedState.pins.find(([prefix]) => t.startsWith(prefix));
          if (pinned) return pinned[1];
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
  embedState.key = "xenova";
  embedState.model = "test-model";
  embedState.pins.length = 0;
  embedState.calls.length = 0;
});

// Env stubs are undone here, not at the end of a test body: a failing
// assertion would otherwise leak the stub into every test that follows.
afterEach(() => {
  vi.unstubAllEnvs();
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
    // The match phase's requirements, plus one cache-key embedding per
    // suggestion cluster (20 requirements / 8 = three) — #72. This fixture has
    // no test cases and its caller returns no suggestions, so there is no case
    // arm and no dedup embedding.
    expect(embedding).toHaveLength(4);
    for (const row of embedding) {
      expect(row).toMatchObject({
        provider: "embed:xenova",
        model: "test-model",
        estimatedCostUsd: 0,
      });
    }
  });
});

/**
 * A fixture whose every (requirement, test case) pair lands in the matcher's
 * AMBIGUOUS band — cosine in [0.62, 0.78), where the hybrid BM25 rule cannot
 * apply — so the judge phase actually runs. Three requirements x four cases =
 * twelve AMBIGUOUS cells = two judge batches of eight.
 */
const REQ_VEC = [1, 0, 0, 0];
const CASE_VEC = [0.7, Math.sqrt(1 - 0.7 * 0.7), 0, 0];

function ambiguousFixture() {
  const requirements = [
    {
      id: "r1",
      title: "Login lockout",
      body: "Lock the account after five failed attempts.",
      priority: "high",
    },
    {
      id: "r2",
      title: "Password reset",
      body: "Email a single-use reset link that expires in an hour.",
      priority: "medium",
    },
    {
      id: "r3",
      title: "Session timeout",
      body: "Sign the user out after thirty idle minutes.",
      priority: "low",
    },
  ];
  const testCases = ["tc1", "tc2", "tc3", "tc4"].map((id, i) => ({
    id,
    title: `Auth regression ${i}`,
    preconditions: "a registered user exists",
    stepsJson: JSON.stringify([{ action: `step ${i}`, expected: `outcome ${i}` }]),
    expected: `the system responds ${i}`,
    priority: "medium",
    tags: JSON.stringify(["auth"]),
    source: "csv",
    externalId: null,
    contentHash: `h${i}`,
  }));
  return { requirements, testCases };
}

/** Pin the fixture's requirement and case texts onto the two band vectors. */
function pinAmbiguousVectors() {
  embedState.pins.push(
    ["Login lockout", REQ_VEC],
    ["Password reset", REQ_VEC],
    ["Session timeout", REQ_VEC],
    ["Auth regression", CASE_VEC],
  );
}

/**
 * Answers judge prompts with verdicts and suggestion prompts with suggestions,
 * so one caller can drive both LLM phases of a single run.
 */
function dualCaller() {
  return vi.fn(async (input: { systemPrompt: string; userPrompt: string; modelId: string }) => {
    if (input.systemPrompt.startsWith("You are a senior QA reviewer")) {
      return {
        raw: JSON.stringify({
          verdicts: Array.from({ length: 8 }, (_, idx) => ({
            idx,
            isCovered: false,
            confidence: 0.1,
          })),
        }),
        promptTokens: 100,
        completionTokens: 50,
        provider: "bedrock-gateway" as const,
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      };
    }
    return stubCaller.call(input);
  });
}

/** The service's own `estimateTokens` heuristic — ~4 characters per token. */
const embedTokens = (texts: string[]) => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);

describe("runCoverageScoring — embedding cost follow-ups (#72, #73, #77)", () => {
  /** Run the ambiguous fixture, pinning its vectors after the first embed pass. */
  async function runAmbiguous(opts: {
    runId: string;
    budgetCents: number;
    call: ReturnType<typeof dualCaller>;
    emit?: (e: CoverageProgressEvent) => void;
  }) {
    const fixture = ambiguousFixture();
    pinAmbiguousVectors();
    const { db, state } = makeDb(fixture);
    const report = await runCoverageScoring(
      { runId: opts.runId, projectId: "p-1", userId: "u-1" },
      {
        db: db as never,
        caller: { call: opts.call },
        budgetCents: opts.budgetCents,
        emit: opts.emit,
      },
    );
    return { report, state, db, fixture };
  }

  it("passes its cost guard to the judge, so the judge phase stops part-way (#73)", async () => {
    const call = dualCaller();
    const events: CoverageProgressEvent[] = [];
    const { report } = await runAmbiguous({
      runId: "run-73",
      // One judge batch (100 prompt + 50 completion Bedrock Haiku tokens)
      // rounds up to exactly 1 cent, so the second batch must not run.
      budgetCents: 1,
      call,
      emit: (e) => events.push(e),
    });

    // Twelve AMBIGUOUS cells → two batches of eight.
    expect(report.matcher.ambiguous).toBe(12);
    // Without the guard the judge runs both batches and never checks a budget.
    expect(report.judge.batches).toBe(1);
    expect(report.judge.modelCalls).toBe(1);
    expect(report.budgetExceeded).toBe(true);
    const judgeDone = events.find((e) => e.phase === "judge" && e.state === "done");
    expect(judgeDone?.detail).toMatchObject({ batches: 1, budgetExceeded: true });
    // The judge's one batch is the only LLM call the run made.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("records an embedding row for the requirements AND for the test cases (#77)", async () => {
    const call = dualCaller();
    const { report, state } = await runAmbiguous({
      runId: "run-77-arms",
      budgetCents: 10_000,
      call,
    });

    expect(report.matcher.ambiguous).toBe(12);
    const rows = vi.mocked(prisma.aITokenUsage.create).mock.calls.map((c) => c[0].data);
    const embedding = rows.filter((r) => r.agentStep === "testcoverage.embedding");
    // Six embedder calls are billed by a run over this fixture: the match
    // phase's requirements and test cases; one cache key per judge batch (two);
    // and the suggestion cluster's prompt plus its dedup texts (#72).
    expect(embedding).toHaveLength(6);
    for (const row of embedding) {
      expect(row).toMatchObject({
        provider: "embed:xenova",
        model: "test-model",
        estimatedCostUsd: 0,
      });
    }
    // Both match-phase arms are present. The #58 fixture had no test cases, so
    // deleting the case arm's record left every test green (#77).
    const reqTexts = embedState.calls[0];
    const caseTexts = embedState.calls[1];
    expect(reqTexts).toHaveLength(3);
    expect(caseTexts).toHaveLength(4);
    expect(embedTokens(reqTexts)).not.toBe(embedTokens(caseTexts));
    const billed = embedding.map((r) => r.totalTokens);
    expect(billed).toContain(embedTokens(reqTexts));
    expect(billed).toContain(embedTokens(caseTexts));
    // The run row's total is every embedder call, not just the match phase.
    expect(state.run.embeddingTokens).toBe(
      embedState.calls.reduce((n, texts) => n + embedTokens(texts), 0),
    );
  });

  /** Every persisted usage row, and the embedding subset, for the current test. */
  function persistedRows() {
    const rows = vi.mocked(prisma.aITokenUsage.create).mock.calls.map((c) => c[0].data);
    const embedding = rows.filter((r) => r.agentStep === "testcoverage.embedding");
    // Set the two match-phase rows aside by the token count of the exact texts
    // the embedder was handed, so what is left is the four calls #72 added:
    // one cache key per judge batch, the suggestion cluster prompt, its dedup.
    const inLoop = [...embedding];
    for (const texts of [embedState.calls[0], embedState.calls[1]]) {
      const i = inLoop.findIndex((r) => r.totalTokens === embedTokens(texts));
      expect(i).toBeGreaterThanOrEqual(0);
      inLoop.splice(i, 1);
    }
    const usd = (rs: typeof rows) => rs.reduce((n, r) => n + Number(r.estimatedCostUsd ?? 0), 0);
    return { rows, embedding, inLoop, usd };
  }

  it("a priced cloud embedder bills every in-loop call at its published rate (#72 AC2)", async () => {
    // AC2 asks for one test where a priced cloud embedder's in-loop calls are
    // visible on the budget — not for a reader to compose that from "the calls
    // are recorded" and "recorded calls are priced".
    embedState.key = "openai";
    embedState.model = "text-embedding-3-large";
    const { report } = await runAmbiguous({
      runId: "run-72-ac2",
      budgetCents: 10_000,
      call: dualCaller(),
    });

    const { rows, embedding, inLoop, usd } = persistedRows();
    expect(embedding).toHaveLength(6);
    expect(inLoop).toHaveLength(4);
    // $0.13/MTok — the published OpenAI price the rate table carries.
    const perToken = 0.13 / 1_000_000;
    for (const row of embedding) {
      expect(row.provider).toBe("embed:openai");
      expect(row.model).toBe("text-embedding-3-large");
      expect(Number(row.estimatedCostUsd)).toBeCloseTo(row.totalTokens * perToken, 12);
    }
    // None of it is guesswork the budget has to disclaim.
    expect(report.cost.unpricedEmbeddingTokens).toBe(0);
    // The in-loop calls are the MAJORITY of a run's embedding tokens here, and
    // the run's reported spend is every priced row, those four included.
    expect(usd(inLoop)).toBeGreaterThan(usd(embedding) / 2);
    expect(report.cost.usedCents).toBe(Math.ceil(usd(rows) * 100));
  });

  it("an administrator's embedding price moves the run budget by the in-loop calls (#72 AC2)", async () => {
    // The published rate is fractions of a cent on a fixture this size, so the
    // cents the budget reports cannot show the difference. `MODEL_PRICES` with
    // an `embed:<backend>:<model>` key is the documented way to put a model on
    // the cap (#77); at a price that registers, the four in-loop calls are
    // plainly the reason the run's cents read what they do.
    vi.stubEnv(
      "MODEL_PRICES",
      JSON.stringify({
        "embed:openai:text-embedding-3-large": { inputPerMTok: 10_000, outputPerMTok: 0 },
      }),
    );
    embedState.key = "openai";
    embedState.model = "text-embedding-3-large";
    const { report } = await runAmbiguous({
      runId: "run-72-ac2-priced",
      budgetCents: 100_000,
      call: dualCaller(),
    });

    const { rows, inLoop, usd } = persistedRows();
    expect(inLoop).toHaveLength(4);
    const totalCents = Math.ceil(usd(rows) * 100);
    const withoutInLoop = Math.ceil((usd(rows) - usd(inLoop)) * 100);
    expect(report.cost.usedCents).toBe(totalCents);
    // Not a rounding artefact: the in-loop calls are worth hundreds of cents.
    expect(totalCents - withoutInLoop).toBeGreaterThan(100);
  });

  it("an unpriced cloud embedder no longer stops a budgeted run (#77)", async () => {
    // `openai` also serves Azure deployment names, which are not model ids
    // METIS can price. Embedding is the run's FIRST recorded usage, so failing
    // closed here ended the run before the judge had started.
    embedState.key = "openai";
    embedState.model = "my-azure-deployment";
    const call = dualCaller();
    const { report } = await runAmbiguous({
      runId: "run-77-unpriced-embedder",
      budgetCents: 10_000,
      call,
    });

    expect(report.judge.modelCalls).toBe(2);
    expect(report.suggestions.generated).toBeGreaterThan(0);
    expect(report.budgetExceeded).toBe(false);
    // The unknown spend is still reported — `usedCents` is a lower bound.
    expect(report.cost.unpricedEmbeddingTokens).toBeGreaterThan(0);
    expect(report.cost.unpricedLlmTokens).toBe(0);
    expect(report.cost.unpricedTokens).toBe(report.cost.unpricedEmbeddingTokens);
  });

  it("an unpriced JUDGE model still stops the run, even behind a priced embedder (#43)", async () => {
    // The control for the test above: #77 relaxes the embedding arm only.
    const call = vi.fn(
      async (input: { systemPrompt: string; userPrompt: string; modelId: string }) => ({
        ...(await dualCaller()(input)),
        provider: "anthropic" as const,
        model: "deepseek-v4-pro",
      }),
    );
    const { report } = await runAmbiguous({
      runId: "run-77-unpriced-judge",
      budgetCents: 10_000,
      call,
    });

    expect(report.judge.modelCalls).toBe(1);
    expect(report.budgetExceeded).toBe(true);
    expect(report.cost.unpricedLlmTokens).toBe(150);
  });
});
