/**
 * Tests for TestCoverage background task runner (Epic #856 issue #862).
 */
import { describe, it, expect, vi } from "vitest";
import {
  runTestCoverageJob,
  createDefaultEnqueueRun,
  configureTestCoverageRuntime,
  __resetTestCoverageRuntime,
  TEST_COVERAGE_PHASES,
  type TestCoverageEvent,
} from "../../../src/lib/testcoverage/task-runner.js";
import { readBudget, DEFAULT_BUDGET_CENTS } from "../../../src/lib/testcoverage/cost-tracker.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  return {
    updates,
    db: {
      testCoverageRun: {
        findUnique: vi.fn().mockResolvedValue({ id: "run-1", status: "queued" }),
        update: vi.fn(
          async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
            updates.push({ where, data });
            return { id: "run-1", ...data };
          },
        ),
      },
      testCaseDoc: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      coverageMapping: { count: vi.fn().mockResolvedValue(0) },
      gapItem: { count: vi.fn().mockResolvedValue(0) },
      suggestion: { count: vi.fn().mockResolvedValue(0) },
      ...overrides,
    },
  };
}

describe("runTestCoverageJob", () => {
  it("does nothing when the run row does not exist", async () => {
    const { db } = makeDb({
      testCoverageRun: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    });
    const emitter = vi.fn();
    await runTestCoverageJob({ runId: "run-1", projectId: "p-1" }, { db: db as never, emitter });
    expect(emitter).not.toHaveBeenCalled();
    expect(db.testCoverageRun.update).not.toHaveBeenCalled();
  });

  it("skips runs already in a non-queued state", async () => {
    const { db } = makeDb({
      testCoverageRun: {
        findUnique: vi.fn().mockResolvedValue({ id: "run-1", status: "completed" }),
        update: vi.fn(),
      },
    });
    await runTestCoverageJob({ runId: "run-1", projectId: "p-1" }, { db: db as never });
    expect(db.testCoverageRun.update).not.toHaveBeenCalled();
  });

  it("runs the full phase sequence and emits lifecycle events", async () => {
    const { db, updates } = makeDb();
    const events: TestCoverageEvent[] = [];
    const indexer = { index: vi.fn().mockResolvedValue({ inserted: 0, skipped: [] }) };
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, emitter: (e) => events.push(e), indexer: indexer as never },
    );

    expect(events[0]).toMatchObject({ type: "run:started" });
    const phaseEvents = events.filter((e) => e.type === "run:progress").map((e) => e.phase);
    // Every phase emits at least one progress event
    for (const p of TEST_COVERAGE_PHASES) {
      expect(phaseEvents).toContain(p);
    }
    expect(events[events.length - 1]).toMatchObject({ type: "run:completed" });

    // Final update sets status=completed with completedAt
    const finalCompletion = updates.find(
      (u) => (u.data as { status?: string }).status === "completed",
    );
    expect(finalCompletion).toBeDefined();
    expect((finalCompletion!.data as { completedAt?: Date }).completedAt).toBeInstanceOf(Date);
  });

  it("indexes existing test cases when present", async () => {
    const { db } = makeDb({
      testCaseDoc: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "doc-1",
            contentHash: "abc",
            title: "Login",
            preconditions: null,
            stepsJson: JSON.stringify([{ action: "click", expected: "ok" }]),
            expected: "Dashboard",
            priority: "medium",
            tags: JSON.stringify(["auth"]),
            externalId: null,
            source: "csv",
          },
        ]),
      },
    });
    const indexer = { index: vi.fn().mockResolvedValue({ inserted: 1, skipped: [] }) };
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, indexer: indexer as never },
    );
    expect(indexer.index).toHaveBeenCalledWith(
      "p-1",
      expect.arrayContaining([expect.objectContaining({ docId: "doc-1", contentHash: "abc" })]),
      expect.objectContaining({ cost: expect.anything() }),
    );
  });

  describe("index-phase embedding usage on the run budget (#72)", () => {
    /** One persisted test case, so the index phase has something to embed. */
    function dbWithOneCase() {
      const built = makeDb({
        testCaseDoc: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "doc-1",
              contentHash: "abc",
              title: "Login",
              preconditions: null,
              stepsJson: JSON.stringify([{ action: "click", expected: "ok" }]),
              expected: "Dashboard",
              priority: "medium",
              tags: JSON.stringify(["auth"]),
              externalId: null,
              source: "csv",
            },
          ]),
        },
      });
      // Keep makeDb's recording `update` spy — only the run row needs an owner.
      built.db.testCoverageRun.findUnique = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "queued", createdById: "user-1" });
      return built;
    }

    /** An indexer that bills a known cloud-embedder batch, as the real one now does. */
    function billingIndexer(tokens: number) {
      return {
        index: vi.fn(
          async (
            _projectId: string,
            _cases: unknown[],
            opts?: { cost?: { record: (u: Record<string, unknown>) => void } },
          ) => {
            opts?.cost?.record({
              phase: "embedding",
              embedder: "openai",
              modelId: "text-embedding-3-small",
              embeddingTokens: tokens,
            });
            return { inserted: 1, skipped: [] };
          },
        ),
      };
    }

    it("hands the run's cost tracker to the index phase and flushes it (#72)", async () => {
      // No caller is wired, so `runCoverageScoring` — which used to own the only
      // tracker in a run — never runs. The index phase must still be billed.
      const { db, updates } = dbWithOneCase();
      const indexer = billingIndexer(1_000);
      await runTestCoverageJob(
        { runId: "run-1", projectId: "p-1" },
        { db: db as never, indexer: indexer as never },
      );

      expect(indexer.index).toHaveBeenCalledWith(
        "p-1",
        expect.any(Array),
        expect.objectContaining({ cost: expect.anything() }),
      );
      const flushed = updates.find((u) => "embeddingTokens" in u.data);
      expect(flushed).toBeDefined();
      expect(flushed!.data).toMatchObject({
        embeddingTokens: 1_000,
        // 1,000 tokens of text-embedding-3-small at $0.002/1K = $0.002, which
        // the tracker rounds up to 1 cent of the 20-cent cap.
        tokenCostCents: 1,
        judgeTokens: 0,
        suggestionTokens: 0,
      });
    });

    it("shares ONE tracker across the index phase and the scoring service (#72)", async () => {
      const { db, updates } = dbWithOneCase();
      // `makeDb` has no `requirement` delegate; add one for the scoring phase.
      Object.assign(db, {
        requirement: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "r1", title: "X", body: "body content", priority: "low" }]),
        },
      });
      db.coverageMapping = {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      } as never;
      db.gapItem = {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      } as never;
      db.suggestion = {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      } as never;
      const indexer = billingIndexer(1_000);
      const caller = {
        call: vi.fn().mockResolvedValue({
          raw: JSON.stringify({ suggestions: [] }),
          promptTokens: 0,
          completionTokens: 0,
          provider: "bedrock-gateway" as const,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        }),
      };
      await runTestCoverageJob(
        { runId: "run-1", projectId: "p-1" },
        { db: db as never, indexer: indexer as never, caller, budgetCents: 10_000 },
      );

      // A separate tracker per phase would persist only the match phase's own
      // embedding tokens; one shared tracker carries the index phase's too.
      const totals = updates
        .filter((u) => "embeddingTokens" in u.data)
        .map((u) => (u.data as { embeddingTokens: number }).embeddingTokens);
      expect(totals.length).toBeGreaterThan(0);
      expect(Math.max(...totals)).toBeGreaterThan(1_000);
    });
  });

  it("marks run as failed and emits run:failed when a phase throws", async () => {
    const { db } = makeDb({
      testCaseDoc: {
        findMany: vi.fn().mockRejectedValue(new Error("boom")),
      },
    });
    const events: TestCoverageEvent[] = [];
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, emitter: (e) => events.push(e) },
    );
    const failed = events.find((e) => e.type === "run:failed");
    expect(failed).toBeDefined();
    expect(failed?.error).toBe("boom");
    expect(db.testCoverageRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: "boom" }),
      }),
    );
  });
  it("invokes the coverage scoring service when a judge caller is wired", async () => {
    const stubCaller = {
      async call() {
        return {
          raw: JSON.stringify({ suggestions: [] }),
          promptTokens: 0,
          completionTokens: 0,
          provider: "bedrock-gateway" as const,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        };
      },
    };
    const reqFindMany = vi
      .fn()
      .mockResolvedValue([{ id: "r1", title: "X", body: "body content", priority: "low" }]);
    const { db } = makeDb({
      testCoverageRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "queued",
          createdById: "user-1",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      requirement: { findMany: reqFindMany },
      coverageMapping: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gapItem: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      suggestion: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const events: TestCoverageEvent[] = [];
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      {
        db: db as never,
        emitter: (e) => events.push(e),
        caller: stubCaller,
        budgetCents: 300,
      },
    );
    expect(reqFindMany).toHaveBeenCalled();
    expect(events[events.length - 1]).toMatchObject({ type: "run:completed" });
  });
});

describe("the budget endpoint reads the run's own cap and live spend (#81)", () => {
  /**
   * ONE stateful run row serving both sides: the runner writes it, and
   * `readBudget` — what the budget endpoint calls — reads it back. Asserting on
   * the read, not on the update calls, is the point: before #81 every write
   * succeeded and the read still reported the default cap.
   */
  function statefulRun() {
    const row: Record<string, unknown> = {
      id: "run-1",
      status: "queued",
      createdById: "user-1",
      tokenCostCents: 0,
      budgetCents: null,
      embeddingTokens: 0,
      judgeTokens: 0,
      suggestionTokens: 0,
    };
    const { db } = makeDb({
      testCoverageRun: {
        findUnique: vi.fn(async () => ({ ...row })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return { ...row };
        }),
      },
      testCaseDoc: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "doc-1",
            contentHash: "abc",
            title: "Login",
            preconditions: null,
            stepsJson: JSON.stringify([{ action: "click", expected: "ok" }]),
            expected: "Dashboard",
            priority: "medium",
            tags: JSON.stringify(["auth"]),
            externalId: null,
            source: "csv",
          },
        ]),
      },
      aITokenUsage: { aggregate: vi.fn(async () => ({ _sum: { totalTokens: null } })) },
    });
    return { db, row };
  }

  /** Bills 1,000 tokens of a priced cloud embedder (rounds up to 1 cent), then optionally throws. */
  function indexer(opts: { fail?: boolean } = {}) {
    return {
      index: vi.fn(
        async (
          _p: string,
          _c: unknown[],
          o?: { cost?: { record: (u: Record<string, unknown>) => void } },
        ) => {
          o?.cost?.record({
            phase: "embedding",
            embedder: "openai",
            modelId: "text-embedding-3-small",
            embeddingTokens: 1_000,
          });
          if (opts.fail) throw new Error("index blew up");
          return { inserted: 1, skipped: [] };
        },
      ),
    };
  }

  it("a run started with a non-default budgetCents reads that cap back through readBudget", async () => {
    const cap = DEFAULT_BUDGET_CENTS + 55;
    const { db } = statefulRun();
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, indexer: indexer() as never, budgetCents: cap },
    );
    const view = await readBudget("run-1", { db: db as never });
    expect(view).toMatchObject({ limitCents: cap, usedCents: 1, remainingCents: cap - 1 });
  });

  it("runs under a LOWER per-run cap the route stored on the row, not the process default (#249)", async () => {
    const processCap = DEFAULT_BUDGET_CENTS + 40;
    const posted = processCap - 17;
    const { db, row } = statefulRun();
    // POST /runs stored the client's cap when it created the queued row.
    row.budgetCents = posted;
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      // The process-wide cap the runtime would pass.
      { db: db as never, indexer: indexer() as never, budgetCents: processCap },
    );
    expect(row.budgetCents).toBe(posted);
    const view = await readBudget("run-1", { db: db as never });
    expect(view).toMatchObject({ limitCents: posted, usedCents: 1 });
  });

  it("clamps a stored cap ABOVE the operator's down to it, so no row can raise the ceiling (#249 review)", async () => {
    const processCap = DEFAULT_BUDGET_CENTS + 1;
    const { db, row } = statefulRun();
    row.budgetCents = processCap * 500;
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, indexer: indexer() as never, budgetCents: processCap },
    );
    expect(row.budgetCents).toBe(processCap);
    const view = await readBudget("run-1", { db: db as never });
    expect(view).toMatchObject({ limitCents: processCap });
  });

  it("clamps against DEFAULT_BUDGET_CENTS when the runtime passes no cap (the production wiring)", async () => {
    const { db, row } = statefulRun();
    row.budgetCents = DEFAULT_BUDGET_CENTS * 500;
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, indexer: indexer() as never },
    );
    expect(row.budgetCents).toBe(DEFAULT_BUDGET_CENTS);
  });

  it("reports the cap and the index-phase spend WHILE the run is still going", async () => {
    const cap = DEFAULT_BUDGET_CENTS + 55;
    const { db } = statefulRun();
    const reads: Array<Promise<unknown>> = [];
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      {
        db: db as never,
        indexer: indexer() as never,
        budgetCents: cap,
        // A budget tile polling the endpoint as the index phase finishes.
        emitter: (e) => {
          if (e.type === "run:progress" && e.phase === "index" && e.detail) {
            reads.push(readBudget("run-1", { db: db as never }));
          }
        },
      },
    );
    expect(reads).toHaveLength(1);
    expect(await reads[0]).toMatchObject({ limitCents: cap, usedCents: 1 });
  });

  it("reports the run's cap from the moment it starts, before any phase has flushed", async () => {
    const cap = DEFAULT_BUDGET_CENTS + 55;
    const { db } = statefulRun();
    let early: unknown;
    const slowIndexer = {
      index: vi.fn(async () => {
        // A budget tile polling while the (long) index phase is still running.
        early = await readBudget("run-1", { db: db as never });
        return { inserted: 1, skipped: [] };
      }),
    };
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, indexer: slowIndexer as never, budgetCents: cap },
    );
    expect(early).toMatchObject({ limitCents: cap, usedCents: 0 });
  });

  it("persists spend incurred before a run failed, instead of reading $0.00", async () => {
    const { db, row } = statefulRun();
    await runTestCoverageJob(
      { runId: "run-1", projectId: "p-1" },
      { db: db as never, indexer: indexer({ fail: true }) as never },
    );
    expect(row.status).toBe("failed");
    const view = await readBudget("run-1", { db: db as never });
    expect(view).toMatchObject({ usedCents: 1, breakdown: { embeddingTokens: 1_000 } });
  });
});

describe("createDefaultEnqueueRun", () => {
  it("schedules the runner asynchronously and resolves immediately", async () => {
    const { db } = makeDb();
    const enqueue = createDefaultEnqueueRun({ db: db as never });
    const started = Date.now();
    await enqueue({ runId: "run-1", projectId: "p-1" });
    expect(Date.now() - started).toBeLessThan(50);
    // Let setImmediate drain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(db.testCoverageRun.update).toHaveBeenCalled();
  });
});

describe("configureTestCoverageRuntime (#886)", () => {
  function makeScoringDb() {
    const reqFindMany = vi
      .fn()
      .mockResolvedValue([{ id: "r1", title: "X", body: "body content", priority: "low" }]);
    const { db } = makeDb({
      testCoverageRun: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "run-1", status: "queued", createdById: "user-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      requirement: { findMany: reqFindMany },
      coverageMapping: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gapItem: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      suggestion: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    return { db, reqFindMany };
  }

  async function drain() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it("threads the runtime caller + emitter through the default enqueue hook", async () => {
    const { db, reqFindMany } = makeScoringDb();
    const events: TestCoverageEvent[] = [];
    const caller = {
      modelFor: (tierId: string) => tierId,
      call: vi.fn().mockResolvedValue({
        raw: JSON.stringify({ suggestions: [] }),
        promptTokens: 0,
        completionTokens: 0,
        provider: "bedrock-gateway" as const,
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      }),
    };
    configureTestCoverageRuntime({
      db: db as never,
      caller,
      emitter: (e) => events.push(e),
    });
    try {
      // Router passes only an (undefined) emitter — the runtime caller must
      // still flow through so judge/suggest are NOT skipped.
      const enqueue = createDefaultEnqueueRun({ emitter: undefined });
      await enqueue({ runId: "run-1", projectId: "p-1" });
      await drain();
    } finally {
      __resetTestCoverageRuntime();
    }
    // Coverage scoring ran (requirements were loaded) -> phases not skipped.
    expect(reqFindMany).toHaveBeenCalled();
    expect(events.some((e) => e.type === "run:started")).toBe(true);
    expect(events.some((e) => e.type === "run:completed")).toBe(true);
  });

  it("skips judge/suggest when no caller is configured", async () => {
    __resetTestCoverageRuntime();
    const { db } = makeDb();
    const events: TestCoverageEvent[] = [];
    const enqueue = createDefaultEnqueueRun({ db: db as never, emitter: (e) => events.push(e) });
    await enqueue({ runId: "run-1", projectId: "p-1" });
    await drain();
    const skipped = events.filter(
      (e) => e.type === "run:progress" && ["match", "judge", "suggest"].includes(e.phase ?? ""),
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "run:completed")).toBe(true);
  });

  it("lets explicit deps override the runtime config", async () => {
    const runtimeDb = makeDb().db;
    const explicitMakeDb = makeDb();
    configureTestCoverageRuntime({ db: runtimeDb as never });
    try {
      const enqueue = createDefaultEnqueueRun({ db: explicitMakeDb.db as never });
      await enqueue({ runId: "run-1", projectId: "p-1" });
      await drain();
    } finally {
      __resetTestCoverageRuntime();
    }
    // The explicit db won — its update spy fired, the runtime one did not.
    expect(explicitMakeDb.db.testCoverageRun.update).toHaveBeenCalled();
    expect(runtimeDb.testCoverageRun.update).not.toHaveBeenCalled();
  });
});
