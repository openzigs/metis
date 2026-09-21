/**
 * Tests for replay/runs-service.ts (#110).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

interface RunRow {
  id: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  latencyMs: number | null;
  totalTokens: number;
  costCents: number;
  steps: StepRow[];
  _count?: { steps: number };
}

interface StepRow {
  id: string;
  runId: string;
  ord: number;
  kind: string;
  content: string;
  spanId: string | null;
  traceId: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

interface UsageRow {
  sessionId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  createdAt: Date;
}

const runs: RunRow[] = [];
const steps: StepRow[] = [];
const usage: UsageRow[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    agentRun: {
      create: vi.fn(async ({ data }: { data: Partial<RunRow> }) => {
        const id = `run_${runs.length + 1}`;
        const row: RunRow = {
          id,
          sessionId: data.sessionId ?? "",
          projectId: data.projectId ?? null,
          kind: data.kind ?? "chat",
          status: data.status ?? "running",
          startedAt: new Date(),
          completedAt: null,
          latencyMs: null,
          totalTokens: 0,
          costCents: 0,
          steps: [],
        };
        runs.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({
          where,
          include,
        }: {
          where: { id: string };
          include?: { steps?: { orderBy?: unknown } };
        }) => {
          const r = runs.find((x) => x.id === where.id);
          if (!r) return null;
          if (include?.steps) {
            return {
              ...r,
              steps: steps.filter((s) => s.runId === r.id).sort((a, b) => a.ord - b.ord),
            };
          }
          return r;
        },
      ),
      findMany: vi.fn(
        async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
          const filtered = runs.filter((r) => {
            if (!where) return true;
            if (where.projectId !== undefined && r.projectId !== where.projectId) return false;
            if (where.sessionId !== undefined && r.sessionId !== where.sessionId) return false;
            const startedAt = where.startedAt as { gte?: Date; lte?: Date } | undefined;
            if (startedAt) {
              if (startedAt.gte && r.startedAt < startedAt.gte) return false;
              if (startedAt.lte && r.startedAt > startedAt.lte) return false;
            }
            return true;
          });
          return filtered.slice(0, take).map((r) => ({
            ...r,
            _count: { steps: steps.filter((s) => s.runId === r.id).length },
          }));
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      }),
    },
    tokenUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            sessionId?: string | null;
            createdAt?: { gt?: Date; gte?: Date; lte?: Date };
          };
        }) => {
          return usage.filter((u) => {
            if (where.sessionId !== undefined && u.sessionId !== where.sessionId) return false;
            if (where.createdAt) {
              if (where.createdAt.gt && u.createdAt <= where.createdAt.gt) return false;
              if (where.createdAt.gte && u.createdAt < where.createdAt.gte) return false;
              if (where.createdAt.lte && u.createdAt > where.createdAt.lte) return false;
            }
            return true;
          });
        },
      ),
    },
    agentRunStep: {
      count: vi.fn(
        async ({ where }: { where: { runId: string } }) =>
          steps.filter((s) => s.runId === where.runId).length,
      ),
      create: vi.fn(async ({ data }: { data: Partial<StepRow> }) => {
        const row: StepRow = {
          id: `step_${steps.length + 1}`,
          runId: data.runId ?? "",
          ord: data.ord ?? 0,
          kind: data.kind ?? "prompt",
          content: data.content ?? "",
          spanId: data.spanId ?? null,
          traceId: data.traceId ?? null,
          latencyMs: data.latencyMs ?? null,
          createdAt: new Date(),
        };
        steps.push(row);
        return row;
      }),
    },
  },
}));

import {
  startRun,
  recordStep,
  finishRun,
  listRuns,
  getRun,
  computeRunCost,
} from "../src/lib/replay/runs-service.js";

beforeEach(() => {
  runs.length = 0;
  steps.length = 0;
  usage.length = 0;
});

function seedUsage(row: Partial<UsageRow> & { sessionId: string | null; createdAt: Date }): void {
  usage.push({
    provider: row.provider ?? "anthropic",
    model: row.model ?? "claude-3-5-sonnet",
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
    totalTokens:
      row.totalTokens ??
      (row.inputTokens ?? 0) +
        (row.outputTokens ?? 0) +
        (row.cacheReadTokens ?? 0) +
        (row.cacheWriteTokens ?? 0),
    sessionId: row.sessionId,
    createdAt: row.createdAt,
  });
}

describe("replay/runs-service", () => {
  it("startRun creates a row with running status and returns id", async () => {
    const id = await startRun({ sessionId: "s1", projectId: "p1", kind: "analysis" });
    expect(id).toMatch(/^run_/);
    expect(runs).toHaveLength(1);
    expect(runs[0].sessionId).toBe("s1");
    expect(runs[0].kind).toBe("analysis");
    expect(runs[0].status).toBe("running");
  });

  it("startRun without projectId stores null", async () => {
    await startRun({ sessionId: "s1" });
    expect(runs[0].projectId).toBeNull();
    expect(runs[0].kind).toBe("chat");
  });

  it("recordStep persists JSON-encoded content with monotonic ord", async () => {
    const runId = await startRun({ sessionId: "s1" });
    await recordStep({ runId, kind: "prompt", content: { text: "hi" } });
    await recordStep({ runId, kind: "tool_call", content: { name: "x" } });
    expect(steps).toHaveLength(2);
    expect(steps[0].ord).toBe(0);
    expect(steps[1].ord).toBe(1);
    expect(JSON.parse(steps[0].content)).toEqual({ text: "hi" });
  });

  it("recordStep truncates payloads exceeding 64KB", async () => {
    const runId = await startRun({ sessionId: "s1" });
    const big = "x".repeat(80_000);
    await recordStep({ runId, kind: "response", content: big });
    const parsed = JSON.parse(steps[0].content);
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe("string");
  });

  it("recordStep handles unstringifiable content gracefully", async () => {
    const runId = await startRun({ sessionId: "s1" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await recordStep({ runId, kind: "prompt", content: circular });
    expect(steps[0].content).toContain("unstringifiable");
  });

  it("finishRun stamps completedAt + latency + status", async () => {
    const runId = await startRun({ sessionId: "s1" });
    runs[0].startedAt = new Date(Date.now() - 1000);
    await finishRun({ runId, status: "completed", totalTokens: 42, costCents: 5 });
    expect(runs[0].status).toBe("completed");
    expect(runs[0].latencyMs).toBeGreaterThanOrEqual(900);
    expect(runs[0].totalTokens).toBe(42);
    expect(runs[0].costCents).toBe(5);
  });

  it("finishRun is a no-op when run does not exist", async () => {
    await finishRun({ runId: "missing", status: "completed" });
    // No throw; just nothing happens.
  });

  it("listRuns filters by projectId, sessionId, and date range", async () => {
    await startRun({ sessionId: "s1", projectId: "p1" });
    await startRun({ sessionId: "s2", projectId: "p2" });
    let out = await listRuns({ projectId: "p1" });
    expect(out).toHaveLength(1);
    expect(out[0].projectId).toBe("p1");
    out = await listRuns({ sessionId: "s2" });
    expect(out).toHaveLength(1);
    out = await listRuns({ from: new Date(Date.now() - 1000), to: new Date(Date.now() + 1000) });
    expect(out.length).toBe(2);
    out = await listRuns({ from: new Date(Date.now() + 60_000) });
    expect(out).toHaveLength(0);
  });

  it("listRuns caps limit at 200", async () => {
    for (let i = 0; i < 5; i += 1) {
      await startRun({ sessionId: `s${i}` });
    }
    const out = await listRuns({ limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("getRun returns null for missing id", async () => {
    expect(await getRun("missing")).toBeNull();
  });

  it("getRun returns the run with parsed step content in ord order", async () => {
    const runId = await startRun({ sessionId: "s1" });
    await recordStep({ runId, kind: "prompt", content: { p: 1 } });
    await recordStep({ runId, kind: "response", content: { r: 2 } });
    const out = await getRun(runId);
    expect(out).not.toBeNull();
    expect(out!.steps).toHaveLength(2);
    expect(out!.steps[0].content).toEqual({ p: 1 });
    expect(out!.steps[1].content).toEqual({ r: 2 });
  });

  it("getRun falls back to raw string when content is not valid JSON", async () => {
    const runId = await startRun({ sessionId: "s1" });
    // Inject a corrupt step to exercise the parse fallback.
    steps.push({
      id: "x",
      runId,
      ord: 0,
      kind: "response",
      content: "not-json{",
      spanId: null,
      traceId: null,
      latencyMs: null,
      createdAt: new Date(),
    });
    const out = await getRun(runId);
    expect(out!.steps[0].content).toBe("not-json{");
  });
});

describe("replay/runs-service computeRunCost", () => {
  it("returns zero (no throw) when the run does not exist", async () => {
    const cost = await computeRunCost("missing");
    expect(cost).toEqual({ costCents: 0, totalTokens: 0 });
  });

  it("returns zero when no usage rows fall in the run window", async () => {
    const runId = await startRun({ sessionId: "s1" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // Usage exists but for a different session.
    seedUsage({
      sessionId: "other",
      createdAt: new Date("2026-01-01T00:30:00Z"),
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const cost = await computeRunCost(runId);
    expect(cost).toEqual({ costCents: 0, totalTokens: 0 });
  });

  it("aggregates in-window usage grouped by provider+model into integer cents", async () => {
    const runId = await startRun({ sessionId: "sess-A" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // anthropic:claude-3-5-sonnet → input 0.3¢/1k, output 1.5¢/1k.
    // 10k in + 2k out = (10000*0.3 + 2000*1.5)/1000 = 3 + 3 = 6 cents.
    seedUsage({
      sessionId: "sess-A",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    // openai:gpt-4o → input 0.25¢/1k, output 1.0¢/1k.
    // 4k in + 1k out = (4000*0.25 + 1000*1.0)/1000 = 1 + 1 = 2 cents.
    seedUsage({
      sessionId: "sess-A",
      createdAt: new Date("2026-01-01T00:20:00Z"),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 4_000,
      outputTokens: 1_000,
    });
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(8); // 6 + 2
    expect(cost.totalTokens).toBe(10_000 + 2_000 + 4_000 + 1_000);
  });

  it("sums multiple rows of the same provider+model before applying the rate", async () => {
    const runId = await startRun({ sessionId: "sess-G" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // Two rows, same provider/model: 600 + 400 = 1000 input tokens.
    // (1000 * 0.3)/1000 = 0.3 → rounds to 0 cents per-row, but 1 group sums
    // to 1000 tokens = 0.3 → still 0 here; use larger numbers to prove summing.
    seedUsage({
      sessionId: "sess-G",
      createdAt: new Date("2026-01-01T00:05:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 6_000,
    });
    seedUsage({
      sessionId: "sess-G",
      createdAt: new Date("2026-01-01T00:06:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 4_000,
    });
    // Grouped: 10_000 input * 0.3 / 1000 = 3 cents.
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(3);
    expect(cost.totalTokens).toBe(10_000);
  });

  it("NO DOUBLE-COUNT: two runs in one session attribute only their own window", async () => {
    // Run 1: 00:00 → 00:30. Run 2: 00:30 → 01:00. Same session.
    const run1 = await startRun({ sessionId: "shared" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T00:30:00Z");
    const run2 = await startRun({ sessionId: "shared" });
    runs[1].startedAt = new Date("2026-01-01T00:30:00Z");
    runs[1].completedAt = new Date("2026-01-01T01:00:00Z");

    // Usage inside run 1's window: 10k in + 2k out (sonnet) = 6 cents.
    seedUsage({
      sessionId: "shared",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    // Usage inside run 2's window: 4k in + 1k out (gpt-4o) = 2 cents.
    seedUsage({
      sessionId: "shared",
      createdAt: new Date("2026-01-01T00:45:00Z"),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 4_000,
      outputTokens: 1_000,
    });

    const cost1 = await computeRunCost(run1);
    const cost2 = await computeRunCost(run2);
    // Each run gets ONLY its own window's cost, not the session total (8).
    expect(cost1.costCents).toBe(6);
    expect(cost1.totalTokens).toBe(12_000);
    expect(cost2.costCents).toBe(2);
    expect(cost2.totalTokens).toBe(5_000);
  });

  it("NO DOUBLE-COUNT on a shared boundary: a usage row exactly at run1.completedAt == run2.startedAt attributes only to the earlier run", async () => {
    // Adjacent windows sharing an exact boundary timestamp.
    const boundary = new Date("2026-01-01T00:30:00Z");
    const run1 = await startRun({ sessionId: "edge" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = boundary;
    const run2 = await startRun({ sessionId: "edge" });
    runs[1].startedAt = boundary;
    runs[1].completedAt = new Date("2026-01-01T01:00:00Z");

    // A single usage row timestamped EXACTLY on the shared boundary.
    // sonnet: 10k in + 2k out = 6 cents, 12_000 tokens.
    seedUsage({
      sessionId: "edge",
      createdAt: boundary,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });

    const cost1 = await computeRunCost(run1);
    const cost2 = await computeRunCost(run2);

    // Inclusive-upper / exclusive-lower: the boundary row belongs to run1 only.
    expect(cost1.costCents).toBe(6);
    expect(cost1.totalTokens).toBe(12_000);
    // run2's lower bound is exclusive, so the boundary row is NOT counted here.
    expect(cost2.costCents).toBe(0);
    expect(cost2.totalTokens).toBe(0);
    // Sum across both runs equals the session total: the row is counted once.
    expect(cost1.costCents + cost2.costCents).toBe(6);
    expect(cost1.totalTokens + cost2.totalTokens).toBe(12_000);
  });

  it("uses now() as the upper bound when completedAt is null", async () => {
    const runId = await startRun({ sessionId: "open" });
    runs[0].startedAt = new Date(Date.now() - 60_000);
    runs[0].completedAt = null;
    seedUsage({
      sessionId: "open",
      createdAt: new Date(Date.now() - 30_000),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(6);
  });

  it("finishRun persists a non-zero costCents when in-window usage exists", async () => {
    const runId = await startRun({ sessionId: "wire" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    seedUsage({
      sessionId: "wire",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    const cost = await computeRunCost(runId);
    await finishRun({ runId, status: "completed", ...cost });
    expect(runs[0].costCents).toBe(6);
    expect(runs[0].totalTokens).toBe(12_000);
    expect(runs[0].status).toBe("completed");
  });
});
