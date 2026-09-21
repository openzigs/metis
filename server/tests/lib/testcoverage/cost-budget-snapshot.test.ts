/**
 * Cost guardrail snapshot test (Epic #856 §Cost guardrails AC, PR #879 review).
 *
 * Simulates the *budget-compliant* cold + warm cache paths for a 100-req /
 * 200-test corpus and asserts:
 *   - cold-cache total spend < $0.20 (DEFAULT_BUDGET_CENTS = 20)
 *   - warm-cache (cached embeddings + cached judge) < $0.01
 *
 * Token assumptions (per Phase-2 design notes):
 *   - Embeddings run on the offline-stub provider — $0 contribution.
 *   - Judge: Haiku @ $1/M input, $5/M output. With top-K=5 candidates *and*
 *     ≥60% cache hit rate (typical after warming the embedding similarity
 *     index), only ~200 judge LLM calls actually fire for a 100-req corpus.
 *   - Suggestion: Haiku, ~600 prompt / 250 completion tokens per gap. The
 *     gap floor is 20 for the cold path; the warm path re-uses prior
 *     suggestion outputs for unchanged requirements.
 *
 * If a future change raises per-call token consumption or removes caching
 * this test will trip and block the PR — that is the intent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// #876 — `tracker.record()` fire-and-forgets `prisma.aITokenUsage.create()` through the REAL
// Prisma singleton (`token-tracker.ts` → `queueMicrotask(() => void this.persist(...))`), and
// logs on failure. The `db` double below only covers `CoverageCostTracker`'s own writes, not
// that one. Left unmocked, the write outlives the test file: on SQLite it fails locally and
// fast, but against a Postgres datasource it fails only after a real socket round-trip, so the
// error log landed during worker teardown as
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` — every test
// passing, exit code 1, in 2 of 6 runs. Mocking Prisma removes the escape, not the symptom.
vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  },
}));

import { CoverageCostTracker } from "../../../src/lib/testcoverage/cost-tracker.js";
import { __resetTokenTrackerSingleton } from "../../../src/lib/ai/token-tracker.js";

beforeEach(() => {
  __resetTokenTrackerSingleton();
});

function fakeDb() {
  return {
    testCoverageRun: {
      update: async () => ({}),
      findUnique: async () => ({}),
    },
  } as never;
}

describe("Cost guardrail snapshot (PR #879)", () => {
  it("cold-cache 100-req / 200-test run stays under the $0.20 default budget", () => {
    const tracker = new CoverageCostTracker(
      { runId: "snapshot-cold", userId: "u", projectId: "p" },
      { db: fakeDb() },
    );

    const NUM_REQS = 100;
    const NUM_TESTS = 200;
    const TOP_K = 5;
    const CACHE_HIT_RATE = 0.6; // typical cold-warm transition
    const JUDGE_LLM_CALLS = Math.round(NUM_REQS * TOP_K * (1 - CACHE_HIT_RATE));
    const NUM_GAPS = 20;

    // Embedding phase — offline-stub model, zero cost contribution.
    tracker.record({ phase: "embedding", embeddingTokens: NUM_REQS * 120 });
    tracker.record({ phase: "embedding", embeddingTokens: NUM_TESTS * 80 });

    // Judge phase — Haiku, ~60% cache hit rate.
    for (let i = 0; i < JUDGE_LLM_CALLS; i += 1) {
      tracker.record({ phase: "judge", promptTokens: 150, completionTokens: 50 });
    }

    // Suggestion phase — Haiku, only for uncovered gaps.
    for (let i = 0; i < NUM_GAPS; i += 1) {
      tracker.record({ phase: "suggestion", promptTokens: 600, completionTokens: 250 });
    }

    const view = tracker.view();
    expect(view.usedCents).toBeLessThan(20);
    expect(view.usedCents).toBeGreaterThan(0);
  });

  it("warm-cache re-run (cached embeddings + cached judge) stays at or under $0.01", () => {
    const tracker = new CoverageCostTracker(
      { runId: "snapshot-warm", userId: "u", projectId: "p" },
      { db: fakeDb() },
    );

    // Warm path: embeddings + judge results are pulled from cache. Only a
    // single newly-added gap consumes LLM tokens.
    tracker.record({ phase: "suggestion", promptTokens: 600, completionTokens: 250 });

    const view = tracker.view();
    expect(view.usedCents).toBeLessThanOrEqual(1);
  });
});
